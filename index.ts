

import { config } from 'dotenv';
config({ debug: true });
import { copyItemsToAnotherProject } from './utils'

import * as yargs from 'yargs';


const argv = yargs.options({
  srcPid: {
    alias: 'sp',
    demandOption: true,
    description: 'Source project Number',
    type: 'number'
  },
  destPid: {
    alias: 'dp',
    demandOption: true,
    description: 'Destination Project Number',
    type: 'number'
  },
  srcOrg: {
    alias: 'so',
    demandOption: true,
    description: 'Source Org',
    type: 'string'
  }
  ,
  destOrg: {
    alias: 'do',
    demandOption: true,
    description: 'Destination Org',
    type: 'string'
  },
  dryRun: {
    alias: 'dry',
    demandOption: false,
    default: false,
    description: 'Destination Org',
    type: 'boolean'
  },

})
  .parseSync();

type ArgType = typeof argv;


function main(args: ArgType) {
  console.log(argv);
  copyItemsToAnotherProject({ ...args })
}


main(argv)
