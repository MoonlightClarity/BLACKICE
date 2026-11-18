import test from 'node:test';
import assert from 'node:assert/strict';
import isOpaqueColor from './opaque-color.cjs';
test('render opacity guard rejects transparent and translucent computed rgba colors',()=>{
 for(const color of ['transparent','rgba(0, 0, 0, 0)','rgba(12, 34, 56, 0.0)','rgba(12,34,56,.5)','rgb(12 34 56 / 0%)','rgb(12 34 56 / 50%)',''])assert.equal(isOpaqueColor(color),false,color);
 for(const color of ['rgb(12, 34, 56)','rgba(12, 34, 56, 1)','rgb(12 34 56 / 100%)','rgb(12 34 56)'])assert.equal(isOpaqueColor(color),true,color);
});
