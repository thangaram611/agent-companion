#!/usr/bin/env node
// Environment diagnostics for agent-companion.

import { inspectDoctor, renderDoctorReport } from '../lib/doctor.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: node scripts/doctor.mjs [--json] [--help]';
const unknown = args.find(arg => !['--json', '-h', '--help'].includes(arg));
if (unknown) {
  console.error(`Unknown argument: ${unknown}\n${usage}`);
  process.exit(2);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage);
  process.exit(0);
}
const asJson = args.includes('--json');
const report = await inspectDoctor();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderDoctorReport(report));
}

process.exit(report.ok ? 0 : 1);
