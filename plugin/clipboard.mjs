export async function copyText(value) {
  try {if(!navigator.clipboard?.writeText)throw new Error('clipboard');await navigator.clipboard.writeText(value);}
  catch {
    const target=document.createElement('textarea');target.value=value;target.style.position='fixed';target.style.opacity='0';document.body.append(target);target.select();
    let copied=false;try{copied=document.execCommand('copy');}finally{target.remove();}
    if(!copied)throw new Error('复制未成功，可在用法框中选中文字复制。');
  }
}
