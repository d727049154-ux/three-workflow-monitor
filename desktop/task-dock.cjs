'use strict';
const {BrowserWindow,screen}=require('electron');
const path=require('node:path');
const {dockBounds}=require('./dock-layout.cjs');
class TaskDock {
  constructor({preferences,onChange,onClosed,onError}) {
    this.preferences=preferences;this.onChange=onChange;this.onClosed=onClosed;this.count=3;this.expanded=false;this.adjusting=false;
    preferences.dock||={visible:true,side:'left'};
    const saved=preferences.dock;
    const area=Number.isFinite(saved.x)&&Number.isFinite(saved.y)?screen.getDisplayNearestPoint({x:Math.round(saved.x),y:Math.round(saved.y)}).workArea:screen.getPrimaryDisplay().workArea;
    this.window=new BrowserWindow({...dockBounds(area,saved),title:'进行中任务 · 工作流观察',frame:false,transparent:true,backgroundColor:'#00000000',show:false,resizable:false,skipTaskbar:true,hasShadow:false,alwaysOnTop:preferences.alwaysOnTop,
      webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,spellcheck:false}});
    this.window.setMenu(null);
    this.window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    this.window.webContents.on('will-navigate',event=>event.preventDefault());
    this.window.webContents.on('will-attach-webview',event=>event.preventDefault());
    this.window.webContents.on('render-process-gone',(_event,details)=>onError?.('侧边条显示进程停止：'+details.reason+'。请退出后重开，历史保留。'));
    this.window.on('close',event=>{if(!this.quitting){event.preventDefault();this.hide();this.onClosed?.();}});
    this.window.on('moved',()=>{
      if(this.adjusting)return;
      clearTimeout(this.moveTimer);this.moveTimer=setTimeout(()=>{
        if(this.window.isDestroyed())return;
        const bounds=this.window.getBounds(),work=screen.getDisplayMatching(bounds).workArea;
        this.preferences.dock.side=bounds.x+bounds.width/2<work.x+work.width/2?'left':'right';
        this.preferences.dock.x=Math.round(bounds.x);this.preferences.dock.y=Math.round(bounds.y);
        this.layout();this.onChange();
      },250);
    });
    this.ready=this.window.loadFile(path.join(__dirname,'dock.html')).then(()=>{if(preferences.dock.visible!==false)this.show(false);});
  }
  state(){return {visible:!this.window.isDestroyed()&&this.window.isVisible(),expanded:this.expanded,side:this.preferences.dock.side||'left',bounds:this.window.isDestroyed()?null:this.window.getBounds()};}
  layout(){
    if(this.window.isDestroyed())return;
    const current=this.window.getBounds(),area=screen.getDisplayMatching(current).workArea;
    const next=dockBounds(area,{...this.preferences.dock,expanded:this.expanded,count:this.count});
    if(['x','y','width','height'].every(key=>Math.abs(current[key]-next[key])<2))return;
    this.adjusting=true;this.window.setBounds(next);clearTimeout(this.adjustTimer);this.adjustTimer=setTimeout(()=>{this.adjusting=false;},300);
  }
  setTaskCount(count){if(this.count===count)return;this.count=count;this.layout();}
  expand(value){this.expanded=value;this.preferences.dock.visible=true;this.layout();this.window.show();this.window.moveTop();this.onChange();}
  show(focus=true){this.preferences.dock.visible=true;this.layout();if(focus)this.window.show();else this.window.showInactive();this.window.moveTop();this.onChange();}
  hide(){this.preferences.dock.visible=false;this.window.hide();this.onChange();}
  setSide(side){this.preferences.dock.side=side;this.show();}
  dispose(){this.quitting=true;clearTimeout(this.moveTimer);clearTimeout(this.adjustTimer);if(!this.window.isDestroyed())this.window.destroy();}
}
module.exports={TaskDock};
