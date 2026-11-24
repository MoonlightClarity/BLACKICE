// Verify quoted evidence against the page text actually returned by the reader.
const normalize = text => text.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

export function createDocumentQuoteReview() {
  const pages = new Map();
  const examples = new Map();
  const sections = new Map();
  let revisions = 0;
  return {
    observe(result) {
      for (const page of result?.pages || []) {
        if (typeof page.text !== 'string' || !page.text.trim()) continue;
        // Resume headings pair an employer with a role on a line of their own.
        const blocks = page.text.split(/^([^\r\n]{2,90}) [—–] ([^\r\n]{2,90})\r?$/gm);
        for (let i = 1; i + 2 < blocks.length; i += 3) {
          const heading = blocks[i] + ' — ' + blocks[i + 1];
          sections.set(heading, [sections.get(heading) || '', normalize(blocks[i + 2])].join(' '));
        }
        const bullet = page.text.split(/\r?\n/).find(line => /^\s*•\s+/.test(line));
        if (bullet) examples.set(page.page, bullet.replace(/^\s*•\s*/, '').trim().split(/\s+/).slice(0,12).join(' '));
        const excerpts = pages.get(page.page) || [];
        excerpts.push(normalize(page.text));
        pages.set(page.page, excerpts);
      }
    },
    beforeFinal({output, remainingSteps}) {
      if (!pages.size) return null;
      const quotes = [...output.matchAll(/["“]([^"”\n]{5,})["”]/g)].map(match => normalize(match[1]).replace(/[.,]$/, ''));
      const inventedPassage = quotes.some(quote => quote.split(' ').length >= 6 && !quote.endsWith('?')
        && ![...pages.values()].some(excerpts => excerpts.some(text => text.includes(quote))));
      const misplaced = [...output.matchAll(/["“]([^"”\n]+)["”][ \t]*(?:[—–-][ \t]*|\()[Pp](?:age|\.)\s*(\d+)(?:,\s*([^\n)*]+))?/g)].some(([, passage, number, role]) => {
        const source = pages.get(Number(number)) || [];
        if (!source.some(text => text.includes(normalize(passage).replace(/[.,]$/, '')))) return true;
        return role && !source.some(text => text.includes(normalize(role)));
      });
      const wrongAttribution = [...output.matchAll(/["“]([^"”\n]+)["”]\s*[—–]\s*([^\n]+)/g)].some(([, passage, label]) => {
        const quote = normalize(passage).replace(/[.,]$/, '');
        const attributed = [...sections].filter(([heading]) => heading.split(' — ').some(part => normalize(label).includes(normalize(part))));
        return attributed.length && !attributed.some(([, body]) => body.includes(quote));
      });
      const located = new Set();
      for (const line of output.split(/\n\s*\n/)) {
        const refs = [...line.matchAll(/\b(?:page|p\.)\s*(\d+)/gi)].map(match => Number(match[1]));
        for (const page of refs) {
          if (quotes.some(quote => normalize(line).includes(quote) && pages.get(page)?.some(text => text.includes(quote)))) located.add(page);
        }
      }
      const unknownPage = [...output.matchAll(/\b(?:page|p\.)\s*(\d+)/gi)].some(match => !pages.has(Number(match[1])));
      const unsupportedRatio = [...output.matchAll(/\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b/g)].some(([value]) =>
        ![...pages.values()].some(excerpts => excerpts.some(text => text.includes(value))));
      if (!wrongAttribution && !unknownPage && !unsupportedRatio && !misplaced && !inventedPassage && located.size >= Math.min(2, pages.size)) return null;
      if (revisions++ >= 2 || remainingSteps === 0) {
        throw Object.assign(new Error('The PDF read succeeded, but the assessment could not be verified against passages from the document.'), {code:'DOCUMENT_ASSESSMENT_UNGROUNDED'});
      }
      const verified = [];
      for (const [page, excerpts] of pages) {
        const quote = quotes.find(value => value.length >= 15 && value.length <= 240 && excerpts.some(text => text.includes(value)));
        if (quote || examples.has(page)) verified.push({page, passage:quote || examples.get(page), heading:[...sections].find(([,body]) => body.includes(normalize(quote || examples.get(page))))?.[0]});
      }
      return {continue:true, prompt:'Revise the assessment using the PDF text already returned. Select short verbatim passages from different pages when available. Quote each passage in double quotation marks, name its page and actual role heading, explain what the wording establishes for the hiring decision and where the evidence ends. Keep each role paired with its own employer and dates. Copy brief contiguous phrases exactly. Omit contact details. Do not merge or rewrite passages inside quotation marks. For each quotation, use only a verified page number and copy its exact employer and job title from the heading. Use prose for interview questions. Explain why each example affects the hiring decision. Use these reader-verified examples. Include each page number and its short quotation together, then explain what it shows: ' + JSON.stringify(verified)};
    }
  };
}
