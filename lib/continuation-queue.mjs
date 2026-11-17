/** A single per-conversation admission queue shared by Goal and Autonomy. */
export function continuationQueue(engine) {
  return engine.conversationContinuationQueue ||= new Map();
}
