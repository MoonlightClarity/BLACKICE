# Activity summary

This small Node script produces the project's weekly activity totals.

Run it with:

```sh
node summary.mjs [input.csv] [output.csv]
```

The defaults are `activity.csv` and `summary.csv` in the current working directory. An explicit input or output argument can be an absolute path.

The input has the columns `project,hours`. Project names contain letters only, hours are nonnegative decimal numbers, and records for the same project can occur anywhere in the file. Every input record contributes to that project's total.

The output must have the columns `project,total_hours`, one row for each project, project names in ascending alphabetical order, and total hours formatted with two decimal places. Keep the input data intact.

The checked-in report was produced by the current script and needs investigation.
