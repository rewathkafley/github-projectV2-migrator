import { Octokit } from 'octokit';
import { throttling } from '@octokit/plugin-throttling';
import { UpdateProjectV2ItemFieldValuePayload, AddProjectV2ItemByIdPayload, ProjectV2, Organization, Issue, ProjectV2Item, ProjectV2FieldConfigurationConnection, ProjectV2ItemFieldValue, ProjectV2ItemFieldTextValue, ProjectV2FieldValue, ProjectV2ItemFieldIterationValue, ProjectV2IterationField, ProjectV2ItemFieldSingleSelectValue, ProjectV2SingleSelectField } from "@octokit/graphql-schema";
import { asyncForEach } from "./utils";
Octokit.plugin(throttling);

console.log('app init');

const octokit = new Octokit({
  auth: process.env.GITHUB_PAT,
  throttle: {
    onRateLimit: (retryAfter, options: any, octokit) => {
      console.log('primary rate limit hit');
      octokit.log.warn(
        `Request quota exhausted for request ${options?.method} ${options?.url}`,
      );

      // Retry thrice after hitting a rate limit error, then give up
      if (options?.request.retryCount < 30) {
        console.log(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter, options: any, octokit) => {
      console.log('secondary rate limit hit');
      // only retry once and only logs a warning
      if (options.request.retryCount < 30) {
        console.log(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
      octokit.log.warn(
        `Secondary quota exausted for request ${options?.method} ${options?.url}`
      );
    },
  }
});


function isObjEmpty(obj) {
  if (!obj) return true;
  return Object.values(obj).filter(value => !!value).length === 0 && obj?.constructor === Object;
}


export async function copyItemsToAnotherProject({ srcPid, destPid, srcOrg, destOrg, batchSize = 10, dryRun }) {
  const timeName = 'Total time taken';
  console.time(timeName);
  const startTime = new Date().getTime();

  const preqTime = "Time taken to read data";
  console.time(preqTime)
  const { project: srcProject } = await getProjectV2({ projectNumber: srcPid, org: srcOrg });
  const { project: destProject } = await getProjectV2({ projectNumber: destPid, org: destOrg });
  const { fields: destProjectFields } = await getProjectV2Fields({ org: destOrg, projectNumber: destPid });
  const { project: { items } } = await getProjectV2Items({ projectNumber: srcPid, org: srcOrg })
  console.timeEnd(preqTime);
  console.log('totalItems', items.totalCount);

  if (dryRun) {
    console.log('Run with --dryRun=false to run the actual migration');
    return;
  }


  let addedItemsCount = 0;
  let updatedItemsCount = 0;

  await asyncForEach(items!.edges!, async (edge) => {
    const content = edge?.node?.content as Issue;

    if (edge!.node?.type === 'DRAFT_ISSUE') {
      return;
    }

    const addedItem = await addProjectV2Item({ projectId: destProject!.id, contentId: content.id, org: destOrg })
    console.log(`Item with issue/pr number ${content.number} added. new id is: ${addedItem.item?.id}`);
    addedItemsCount++;

    const updatedItem = await updateProjectV2ItemFields({ projectId: destProject!.id, org: destOrg, srcItem: edge!.node!, destItem: addedItem!.item!, destFields: destProjectFields })
    console.log(`Item with issue/pr number ${content.number} and id ${updatedItem!.id} updated`);
    console.log('-----------------------------------------------------------------------------');
    updatedItemsCount++;
  })

  console.timeEnd(timeName)
  const endTime = new Date().getTime();
  return {
    summary: {
      totalItems: items.totalCount,
      addedItems: addedItemsCount,
      updatedItems: updatedItemsCount,

    },
    timeTaken: Math.round((endTime / startTime) / 1000) + ' seconds'
  }
}


export async function updateProjectV2ItemFields({ org, srcItem, destItem, projectId, destFields }: { srcItem: ProjectV2Item, destItem: ProjectV2Item, destFields: ProjectV2FieldConfigurationConnection } & Record<string, any>) {

  const values = srcItem.fieldValues.nodes?.filter(node => !isObjEmpty(node)).filter(node => node?.field.dataType !== 'TITLE');
  let updatedItem: ProjectV2Item = undefined as any;
  await asyncForEach(values!, async (fieldValue: ProjectV2ItemFieldValue) => {


    let value: ProjectV2FieldValue = {};
    const destFieldId = destFields.edges?.find(edge => edge!.node?.name === fieldValue.field.name)?.node?.id;

    if (!destFieldId) {
      console.warn(`Destintion field id not found for field: ${fieldValue.field.name}. Skipping`)
      return;
    }


    const simpleFieldsMapping = {
      'TEXT': 'text',
      'NUMBER': 'number',
      'DATE': 'date'
    }

    switch (fieldValue?.field.dataType) {

      case "TEXT":
      case "NUMBER":
      case "DATE":
        fieldValue = (fieldValue as ProjectV2ItemFieldTextValue)
        value[simpleFieldsMapping[fieldValue?.field.dataType]] = fieldValue[simpleFieldsMapping[fieldValue?.field.dataType]]
        break;

      case "ITERATION":
        fieldValue = (fieldValue as ProjectV2ItemFieldIterationValue)
        const title = fieldValue.title;
        const iterationField = destFields.edges?.find(edge => (edge?.node as ProjectV2IterationField).name === fieldValue.field.name)
        const iterations = [...(iterationField?.node as ProjectV2IterationField).configuration?.iterations, ...(iterationField?.node as ProjectV2IterationField).configuration.completedIterations]
        const iterationId = iterations.find(ite => ite?.title === title)?.id
        if (iterationId) {
          value.iterationId = iterationId;
        }
        break;

      case "SINGLE_SELECT":
        fieldValue = (fieldValue as ProjectV2ItemFieldSingleSelectValue);
        const fieldName = fieldValue.name;
        const singleSelectField = destFields.edges?.find(edge => (edge?.node as ProjectV2SingleSelectField).name === fieldValue.field.name)?.node
        const optionId = (singleSelectField as ProjectV2SingleSelectField).options.find(opt => opt.name === fieldName)?.id;
        if (optionId) {
          value.singleSelectOptionId = optionId;
        }
        break;

    }

    if (isObjEmpty(value)) {
      console.warn('Skipping field update.Could not determine the value for field: ' + fieldValue.field.name)
      return;
    };

    console.log("Value is", JSON.stringify(value))
    console.log("Field type is", fieldValue?.field.dataType)
    const { item } = await updateProjectV2Item({ projectId, itemId: destItem.id, fieldId: destFieldId, org, value })
    updatedItem = item!;
    value = {}
  })
  return updatedItem;
}

export async function addProjectV2Item({ projectId, contentId, org }) {

  const mutation = `mutation addProjectV2Item($contentId: ID!,$projectId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item {
      content {
        ... on Issue {
          id
        }
      }
      id
      type
    }
  }
}`


  //octokit.rest.issues.get({issue_number: contentId, })
  const result = await octokit.graphql<{ addProjectV2ItemById: AddProjectV2ItemByIdPayload }>(mutation,
    {
      projectId, contentId,
    })


  return {
    item: result['addProjectV2ItemById']['item'],
  }
}

export async function updateProjectV2Item({ projectId, itemId, fieldId, org, value }) {

  const mutation = `mutation UpdateProjectItem($projectId: ID!, $itemId:ID!, $fieldId: ID!,$value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: $value
      }
    ) {
      projectV2Item {
        id
      }
    }
  }`


  const result = await octokit.graphql<{ updateProjectV2ItemFieldValue: UpdateProjectV2ItemFieldValuePayload }>(mutation,
    {
      org, projectId, itemId, fieldId,
      value
    });

  return {
    item: result['updateProjectV2ItemFieldValue']['projectV2Item'],
  }
}

export async function getProjectV2Items({ projectNumber, org }) {

  const query = `query GetAllProjectItems($login: String!,$projectNumber: Int!, $cursor: String) {
  organization(login: $login) {
    projectV2(number: $projectNumber) {
      items(first: 10, after: $cursor) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            content {
              ... on Issue {
                id
                number
              }
            }
            type
            fieldValues(first: 100) {
              totalCount
              nodes {
                ... on ProjectV2ItemFieldTextValue {
                  id
                  text
                  field {
                    ... on ProjectV2Field {
                      id
                      name
                      dataType
                    }
                  }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  id
                  name
                  field {
                    ... on ProjectV2SingleSelectField {
                      id
                      name
                      options {
                        id
                        name
                      }
                      dataType
                    }
                  }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  id
                  number
                  field {
                    ... on ProjectV2Field {
                      id
                      name
                      dataType
                    }
                  }
                }
                ... on ProjectV2ItemFieldDateValue {
                  id
                  date
                  field {
                    ... on ProjectV2Field {
                      id
                      name
                      dataType
                    }
                  }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  id
                  field {
                    ... on ProjectV2IterationField {
                      id
                      name
                      dataType
                    }
                  }
                  title
                }
              }
            }
          }
          cursor
        }
      }
      id
    }
  }
}`

  const result = await octokit.graphql.paginate<{ organization: Organization }>(query, {
    login: org,
    projectNumber
  })

  return {
    project: result['organization']['projectV2'] as ProjectV2,
    org,
    projectNumber
  };
}

export async function getProjectV2Fields({ org, projectNumber }) {
  const query = `query GetProjectFields($login: String!,$projectNumber: Int!, $cursor: String) {
  organization(login: $login) {
    projectV2(number: $projectNumber) {
      id
      fields(first: 10, after: $cursor) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          node {
            ... on ProjectV2Field {
              id
              name
              dataType
            }
            ... on ProjectV2IterationField {
              id
              name
              dataType
              configuration {
                duration
                startDay
                iterations {
                  id
                  title
                  startDate
                  duration
                }
                completedIterations {
                  duration
                  id
                  startDate
                  title
                }
              }
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              dataType
              options {
                name
                id
              }
            }
          }
        }
      }
    }
  }
}`


  const result = await octokit.graphql.paginate<{ organization: Organization }>(query, {
    login: org,
    projectNumber
  })

  return {
    project: result['organization']['projectV2'],
    org,
    projectNumber,
    fields: result['organization']['projectV2']!['fields']
  };


}


export async function getProjectV2({ projectNumber, org }) {
  const query = `query getProject($login: String!, $projectNumber: Int!) {
      organization(login: $login) {
        projectV2(number: $projectNumber) {
          id
          fields(first:1) {
          totalCount
        }
        items(first:1){
          totalCount
        }
        }
      }
    }`

  const result = await octokit.graphql<{ organization: Organization }>(query, { login: org, projectNumber });

  const project = result['organization']['projectV2']

  return { project };
}