import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] || 'activity.csv';
const output = process.argv[3] || 'summary.csv';
const lines = readFileSync(input, 'utf8').trim().split(/\r?\n/);
const totals = new Map();

for (const line of lines.slice(1)) {
  const [project, hoursText] = line.split(',');
  const hours = Number(hoursText);
  totals.set(project, hours);
}

const rows = [...totals].sort(([a], [b]) => a.localeCompare(b));
const csv = ['project,total_hours', ...rows.map(([project, hours]) => project + ',' + hours.toFixed(2))].join('\n') + '\n';
writeFileSync(output, csv);
