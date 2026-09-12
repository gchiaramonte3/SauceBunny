// Select the exact native artifact for generated-window service checks.
// An application target must pass the enclosing-app verifier before any launch.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { verifyObsApp } from './verify-obs-app.mjs';

const usage = 'usage: node scripts/verify-obs-service.mjs <signed-private-runtime | application.app --application> [--raw-output | --source-lifecycle [M|R|H|C|Q]]';

export function serviceTestTarget(args, { verifyApplication = verifyObsApp } = {}) {
  const [target, ...options] = args;
  assert(typeof target === 'string' && target.length > 0 && !target.startsWith('-'), usage);
  const application = options[0] === '--application';
  if (application) options.shift();
  const rawOutput = options.length === 1 && options[0] === '--raw-output';
  const lifecycle = options[0] === '--source-lifecycle' &&
    (options.length === 1 || (options.length === 2 && /^[MRHCQ]$/.test(options[1])));
  assert(options.length === 0 || rawOutput || lifecycle, usage);
  const requested = resolve(target);
  assert(application || !requested.toLowerCase().endsWith('.app'), 'Use --application to verify and test an enclosing app.');
  assert(!application || requested.toLowerCase().endsWith('.app'), 'An --application target must be an app bundle.');
  const appProof = application ? verifyApplication(requested) : null;
  const runtime = appProof ? join(appProof.app, 'Contents/Helpers/OBS.bundle/Contents') : requested;
  const actions = lifecycle ? (options[1] ? [options[1]] : ['M', 'R', 'H', 'C', 'Q']) : [''];
  return { runtime, profile: application ? 'application' : 'diagnostic', rawOutput, actions, appProof };
}
