import 'reflect-metadata';
import { loadEnvFiles } from '../../src/config/app-config';

// Each test worker loads apps/api/.env and the repo-root .env (real env vars win), so
// TEST_DATABASE_URL set on the command line overrides the file value.
loadEnvFiles();
process.env.NODE_ENV = 'test';
