// Job engagement evidence is role-scoped. A company's business model never proves
// whether its own staff vacancies are employee roles.
const text = value => typeof value === 'string' ? value.slice(0, 20000) : '';
const nonEmployee = /\b(?:1099|freelanc(?:e|er|ing)|independent[\s-]+contractor|self[\s-]+employed|gig[\s-]+(?:work|worker|assignment)|paid[\s-]+per[\s-]+task)\b/i;
const w2 = /\bw[\s-]?2\b/i;
const employeeRole = /\b(?:regular|permanent|salaried|payroll|full[\s-]?time)\s+employee\b/i;
const freelanceTitle = /\b(?:freelance|1099)\b/i;
const exactIndependentTitle = /^independent[\s-]+contractor$/i;
const listingClassification = /\b(?:(?:job|position|employment|engagement|worker)\s+(?:type|classification|status)\s*[:\-]\s*|this\s+(?:is|will be)\s+(?:an?\s+)?)(?:1099|freelanc(?:e|er)|independent[\s-]+contractor)\b|\b(?:1099|freelance|independent[\s-]+contractor)\s+(?:role|position|opportunity|assignment)\b/i;
const listingEngagement = /(?:\b(?:this|the|our)\s+(?:job|role|position|opportunity|engagement|assignment)\s+(?:is|will be|would be|operates as)\s+(?:an?\s+)?(?:1099|freelanc(?:e|er)|independent[\s-]+contractor|gig[\s-]+work)\b|\b(?:you|applicants?|the successful candidate)\s+(?:will|would|must|are)\s+(?:be\s+)?(?:work(?:ing)? as\s+|hired as\s+|classified as\s+)?(?:an?\s+)?(?:1099|freelanc(?:e|er)|independent[\s-]+contractor)\b|\b(?:paid|payment|compensated|compensation)\s+(?:on a\s+|is\s+)?(?:per[\s-]+task|per[\s-]+project|per[\s-]+assignment|by the task)\b)/i;

export function classifyJobEngagement(candidate = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new TypeError('Expected one job candidate object.');
  const declared = [candidate.employmentType, candidate.engagementType, candidate.payArrangement, candidate.contractType]
    .map(text).filter(Boolean).join(' ').slice(0, 2000);
  const title = [candidate.title, candidate.role].map(text).filter(Boolean).join(' ').slice(0, 500);
  const listing = [candidate.description, candidate.postingText, candidate.jobDescription]
    .map(text).filter(Boolean).join('\n').slice(0, 20000);

  const contractorDeclared = nonEmployee.test(declared);
  const contractorRole = freelanceTitle.test(title) || exactIndependentTitle.test(title.trim()) || listingEngagement.test(listing) || listingClassification.test(listing);
  const employeeDeclared = w2.test(declared) || /\bemployee\b/i.test(declared);
  const employeeInListing = employeeRole.test(listing) || /\bw[\s-]?2\s+(?:employee|payroll|employment|role|position)\b/i.test(listing);
  const employee = employeeDeclared || employeeInListing;
  const contractor = contractorDeclared || contractorRole;

  // A staffing contract can itself be W-2. Do not convert "contract" into 1099.
  if (employee && contractor) return {kind:'w2_option', evidence:'both_employee_and_contractor_terms'};
  if (contractor) return {kind:'non_w2', evidence:contractorDeclared ? 'declared_contractor' : 'role_specific_contractor'};
  if (employee) return {kind:'employee', evidence:employeeDeclared ? 'declared_employee' : 'role_specific_employee'};
  if (/\bcontract(?:[\s-]+to[\s-]+hire)?\b/i.test(declared))
    return {kind:'contract_unclear', evidence:'contract_without_payroll_classification'};
  return {kind:'unspecified', evidence:'no_role_specific_engagement_terms'};
}
