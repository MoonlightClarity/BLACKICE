// Minimal nested HTMLElement fixture for the string-only Configure controller tests.
// The focus suite separately parses rendered children and exercises real ownership.
export class OwnedConfigureMount {
  constructor(parent){this.parent=parent;this.handlers=new Map();this.innerHTML='';}
  get isConnected(){return this.parent?.recoveryMount===this;}
  detach(){this.parent=null;}
  remove(){if(this.parent?.recoveryMount===this)this.parent.recoveryMount=null;this.detach();}
  replaceWith(node){const parent=this.parent;if(!parent)return;node.remove();parent.recoveryMount=node;node.parent=parent;this.detach();}
  contains(target){return target===this;}
  querySelectorAll(){return [];}
  addEventListener(type,handler){let set=this.handlers.get(type);if(!set)this.handlers.set(type,set=new Set());set.add(handler);}
  removeEventListener(type,handler){const set=this.handlers.get(type);set?.delete(handler);if(!set?.size)this.handlers.delete(type);}
  async dispatch(type,target){for(const handler of this.handlers.get(type)||[])await handler({target,preventDefault(){}});}
}
