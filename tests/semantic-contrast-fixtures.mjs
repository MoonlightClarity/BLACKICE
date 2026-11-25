/** Synthetic counterfactual pairs: diagnostics for semantic interpretation, never a production gate. */
export const semanticContrastPairs = Object.freeze([
 {id:'actor-attribution',question:"Who identified the unsupported conclusions? A) Mara. B) The twenty experts.",cases:[
  {id:'candidate-identified',source:"Mara audited twenty experts. Mara identified unsupported conclusions in the experts' submitted reports.",answer:'A'},
  {id:'experts-identified',source:"Twenty experts audited Mara's report. The experts identified unsupported conclusions in Mara's submitted work.",answer:'B'}]},
 {id:'repository-presence',question:"Does this source provide a repository link? A) Yes. B) No.",cases:[
  {id:'link-present',source:"The project description explicitly includes: Repository: https://example.test/source-project.",answer:'A'},
  {id:'link-absent',source:"The project description contains no repository link. It supplies only a plain-language summary of the project.",answer:'B'}]},
 {id:'universal-quantifier',question:"Does this source report that all 48 participants improved? A) Yes. B) No.",cases:[
  {id:'only-18-improved',source:"Of the 48 participants, 18 improved, 24 remained unchanged, and six worsened.",answer:'B'},
  {id:'all-48-improved',source:"All 48 participants improved; no participant was unchanged or worsened.",answer:'A'}]},
 {id:'causal-evidence',question:"Does the source state that the onboarding change's causal effect on churn was established? A) Yes. B) No.",cases:[
  {id:'causality-established',source:"A randomized trial compared the new onboarding to a control condition and established a significant reduction in churn caused by the new onboarding.",answer:'A'},
  {id:'causality-unknown',source:"Churn declined in the quarter the new onboarding appeared. No controlled comparison was performed, and the source says the cause of the decline is not established.",answer:'B'}]},
 {id:'personal-implementation',question:"Does the source explicitly say Mara personally wrote the implementation code? A) Yes. B) No.",cases:[
  {id:'coordination-only',source:"Mara directed the architecture, wrote product requirements, and coordinated coding agents. The account does not claim she personally authored the implementation.",answer:'B'},
  {id:'author-implemented',source:"Mara personally authored the production backend implementation code and deployed the result.",answer:'A'}]},
 {id:'direct-report-management',question:"Does the source establish that the twenty experts were Mara's direct reports? A) Yes. B) No.",cases:[
  {id:'external-experts',source:"Mara audited and coached twenty external subject-matter experts on report quality. No direct reporting relationship was described.",answer:'B'},
  {id:'line-management',source:"Mara was the line manager of twenty subject-matter experts. All twenty reported directly to her.",answer:'A'}]},
 {id:'cross-role-project',question:"Was the platform developed as part of the research analyst's role at Company B? A) Yes. B) No.",cases:[
  {id:'separate-employers',source:"PROFILE: AI Systems Lead. EXPERIENCE: Company A — Product Director, created the Aurora platform. Company B — Research Analyst, audited expert reports and built evaluation rubrics. The source describes these as distinct work entries.",answer:'B'},
  {id:'explicit-company-b-platform',source:"PROFILE: AI Systems Lead. EXPERIENCE: Company A — Product Director, developed unrelated customer software. Company B — Research Analyst, created the Aurora platform for Company B and used it to audit expert reports.",answer:'A'}]},
 {id:'headline-versus-job',question:"Does this source list 'AI Systems Lead' as a separate experience job entry rather than a profile headline? A) Yes. B) No.",cases:[
  {id:'profile-headline',source:"PROFILE HEADLINE: AI SYSTEMS LEAD. EXPERIENCE: Company A — Product Director. Company B — Research Analyst. The phrase appears in the profile heading, above the experience section.",answer:'B'},
  {id:'experience-position',source:"PROFILE HEADLINE: Technical Professional. EXPERIENCE: Company A — AI Systems Lead, 2024 to 2025. Company B — Research Analyst, 2022 to 2024.",answer:'A'}]},
]);
export const semanticContrastCases = Object.freeze(semanticContrastPairs.flatMap(p=>p.cases.map(c=>({...c,pair:p.id,question:p.question}))));
