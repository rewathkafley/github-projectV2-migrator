
# Github Project Classic to Projects V2 Migrator

## Easily migrate your cards and issues from classic project to V2 project

### Usage

```bash
echo GITHUB_PAT >> .env

yarn start --help

or 

yarn start --sp <SOURCE PROJECT ID> --dp <DESTINATION PROJECT ID --so <SOURCE ORG> --do <DESTINATION ORG>

Use --dry to perform a dry run without actually performing the migrations. It will print out the number of cards that will be migrated as well as the time taken to read the cards