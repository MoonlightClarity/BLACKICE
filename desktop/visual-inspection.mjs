import {visualSvgUrl} from '../public/visual-document.mjs';
import {SVG_ASSET_REVIEW} from '../lib/visual-design-checklist.mjs';

export const ASSET_INSPECTION={
 width:816,height:496,
 backgrounds:[{name:'Light',color:'#f4f2ee'},{name:'BLACKICE charcoal',color:'#14181e'},{name:'Mid-value',color:'#52616c'}],
 fitBoxes:[256,64,32],grayscaleFit:96,
 reviewChecklist:SVG_ASSET_REVIEW,
 scope:'Rendered review aid, not a quality score. Each image preserves aspect ratio inside its labeled square fit box. Backgrounds are preview-only; source SVG and transparency are unchanged. Inspect silhouette separation, color-area balance, material/light consistency and small-size readability. Opaque SVG backgrounds remain opaque.',
};

export function assetInspectionHtml(svg){
 const url=visualSvgUrl(svg);if(!url)throw Error('Asset inspection requires a validated static SVG.');
 const src=url.replaceAll('"','&quot;');
 const panels=ASSET_INSPECTION.backgrounds.map(({name,color})=>`<section style="background:${color}"><div class="label">${name}</div><img class="large" src="${src}"/><div class="thumbs"><img width="64" height="64" src="${src}"/><img width="32" height="32" src="${src}"/><img class="gray" width="96" height="96" src="${src}"/></div><div class="label">64 px / 32 px / grayscale 96 px</div></section>`).join('');
 return '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#14181e;color:#d4dbe2;font:14px "Segoe UI",Arial,sans-serif}body{padding:16px;box-sizing:border-box}header{height:24px;line-height:24px;margin-bottom:8px;font-size:16px}.panels{display:flex;gap:8px}section{width:256px;flex-shrink:0}.label{height:24px;line-height:24px;text-align:center;background:#20262d}.large{display:block;width:256px;height:256px}.thumbs{display:flex;height:96px;align-items:center;justify-content:space-around}img{object-fit:contain}.gray{filter:grayscale(1)}footer{margin-top:8px;line-height:18px}</style><header>Asset inspection: color, silhouette and scale</header><div class="panels">'+panels+'</div><footer>Fit-box sizes; inspect the intended scene too. This sheet does not certify design quality.</footer>';
}
