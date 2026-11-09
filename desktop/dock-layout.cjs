'use strict';
function dockBounds(area, {side='left',y,expanded=false,count=3}={}) {
  const rail=Math.min(108,area.width),width=Math.min(expanded?440:rail,area.width);
  const height=Math.min(Math.max(380,210+Math.max(2,Math.min(count,8))*104),Math.max(1,area.height-24));
  const x=side==='left'?area.x:area.x+area.width-width;
  const top=Number.isFinite(y)?y:area.y+(area.height-height)/2;
  return {x:Math.round(x),y:Math.round(Math.min(area.y+area.height-height,Math.max(area.y,top))),width:Math.round(width),height:Math.round(height)};
}
module.exports={dockBounds};
