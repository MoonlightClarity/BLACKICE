/** Conversation-scoped goal controls shared by Chat and slash commands. */
export async function handleConversationGoalsHttp({ req, res, pathname, goals, body, json, mutations = new Set() }) {
  const match = pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/goal$/);
  if (!match) return false;
  try {
    if (req.method === 'GET') {
      json(res, 200, { goal: await goals.get(match[1]) });
    } else if (req.method === 'POST') {
      const value = await body(req, Infinity);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Object.assign(new Error('Provide a goal action.'), { status: 400, code: 'GOAL_INVALID' });
      const pending = goals.control(match[1], value);
      mutations.add(pending);
      try { json(res, 200, await pending); }
      finally { mutations.delete(pending); }
    } else {
      res.setHeader?.('Allow', 'GET, POST');
      json(res, 405, { error: 'Use GET to read a goal or POST to change it.', code: 'GOAL_METHOD' });
    }
  } catch (error) {
    json(res, error.status || (/not found/i.test(error.message) ? 404 : 400), {
      error: error.message, code: error.code || 'GOAL_ERROR',
    });
  }
  return true;
}
