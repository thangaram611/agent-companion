#!/usr/bin/env node
// Environment diagnostics for agent-companion.

import { inspectDoctor, renderDoctorReport } from '../lib/doctor.mjs';

const asJson = process.argv.includes('--json');
const report = await inspectDoctor();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderDoctorReport(report));
}

process.exit(report.ok ? 0 : 1);
