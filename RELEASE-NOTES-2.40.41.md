# BLACKICE 2.40.41

Windows test candidate.

- For a new request that explicitly says what the user wants to stop or replace, Chat can load the owner's Intent Inference skill even with Planning off. It compares recurring duties and outputs with the intended change rather than matching only on keywords. Receipts show whether the provider accepted the skill context.
- When a task needs one usable option, Directory now tells the agent to inspect a real source, record why any route failed, and take the next useful step without marking the prerequisite done. If the outline is still empty after initial work and the agent tries to finish, Directory tells it to use the evidence it already has, add and focus one concrete step, and take that action. This does not add retry allowance or mark an external action complete.
