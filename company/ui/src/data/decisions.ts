import type { DecisionQueue } from '../types'
import queue from './decisions.json'

/**
 * The decision queue now comes from Postgres, not hardcoded here.
 * `build.py` seeds company.decisions and exports decisions.json out of the DB
 * (see company/db/README.md). To change a decision, update the DB and re-run
 * `npm run data` — do not edit source. decisions.json is generated + gitignored.
 */
export const decisionQueue = queue as DecisionQueue
