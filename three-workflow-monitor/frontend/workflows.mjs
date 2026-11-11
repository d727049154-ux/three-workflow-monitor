import { call, native, element, notify } from './bridge.mjs';

export function mountWorkflows(container, subscribe, refresh) {
  if (!container) return;
  let view;
  let draft;
  let revision;
  let listKey;
  const section = element('section', 'panel workflows');
  const heading = element('h2', '', '自定义工作流');
  const list = element('div', 'workflow-list');
  const editor = element('div', 'workflow-editor');
  const error = element('p', 'error');
  const prompt = element('div', 'workflow-prompt');
  const button = (text, action) => {
    const node = element('button', '', text);
    node.type = 'button';
    node.addEventListener('click', () => Promise.resolve().then(action).catch(cause => notify(String(cause))));
    return node;
  };
  section.append(heading, element('p', 'hint', '名称、阶段和项目由你定义。先接入来源，再关联已有聊天或项目进度。'), button('创建工作流', () => edit()), error, list, editor, prompt);
  container.append(section);

  function field(form, title, value, update, maxLength) {
    const label = element('label', 'workflow-field', title);
    const input = element('input');
    input.value = value;
    input.maxLength = maxLength;
    input.addEventListener('input', () => update(input.value));
    label.append(input);
    form.append(label);
    return input;
  }
  function edit(flow) {
    if (!view?.workspace) { notify(view?.workspaceError || '工作区尚未读取'); return; }
    draft = flow ? structuredClone(flow) : { title: '', root: '', stages: [{ label: '' }], sourceIds: [] };
    revision = view.workspace.revision;
    prompt.replaceChildren();
    const form = element('form');
    form.append(element('h3', '', flow ? '编辑工作流' : '创建工作流'));
    const title = field(form, '工作流名称', draft.title, value => { draft.title = value; }, 60);
    title.required = true;
    const root = field(form, '项目绝对目录（可选）', draft.root, value => { draft.root = value; }, 512);
    form.append(button('选择项目目录', async () => { const path = await native('pick_source'); if (path) { draft.root = path; root.value = path; } }));
    const stages = element('div', 'workflow-stages');
    function renderStages() {
      stages.replaceChildren(element('p', 'hint', '阶段 1–10 项；改名、移动保留原身份。'));
      draft.stages.forEach((stage, index) => {
        const row = element('div', 'stage-row');
        const input = field(row, `阶段 ${index + 1}`, stage.label, value => { stage.label = value; }, 30);
        input.required = true;
        const up = button('上移', () => { [draft.stages[index - 1], draft.stages[index]] = [stage, draft.stages[index - 1]]; renderStages(); });
        up.disabled = index === 0;
        const down = button('下移', () => { [draft.stages[index], draft.stages[index + 1]] = [draft.stages[index + 1], stage]; renderStages(); });
        down.disabled = index === draft.stages.length - 1;
        const remove = button('删除阶段', () => { draft.stages.splice(index, 1); renderStages(); });
        remove.disabled = draft.stages.length === 1;
        row.append(up, down, remove);
        stages.append(row);
      });
      const add = button('新增阶段', () => { draft.stages.push({ label: '' }); renderStages(); });
      add.disabled = draft.stages.length >= 10;
      stages.append(add);
    }
    renderStages();
    form.append(stages, element('p', 'hint', '关联来源（也可按同一项目绝对目录关联）'));
    for (const source of view.sources) {
      const label = element('label', 'workflow-source');
      const input = element('input');
      input.type = 'checkbox';
      input.checked = draft.sourceIds.includes(source.id);
      input.addEventListener('change', () => { draft.sourceIds = input.checked ? [...draft.sourceIds, source.id] : draft.sourceIds.filter(id => id !== source.id); });
      label.append(input, document.createTextNode(source.title || source.path));
      form.append(label);
    }
    const save = element('button', 'primary', '保存工作流');
    save.type = 'submit';
    const conflict = element('p', 'error');
    const retry = button('使用最新版本重试草稿', async () => {
      await refresh();
      if (!view.workspace) throw new Error(view.workspaceError);
      revision = view.workspace.revision;
      conflict.textContent = '已选择最新版本；请对照上方工作流检查草稿，再保存。';
      retry.hidden = true;
    });
    retry.hidden = true;
    form.append(conflict, save, button('取消编辑', () => { draft = null; editor.replaceChildren(); }), retry);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      try {
        await call('workflowSave', { expectedRevision: revision, workflow: draft });
        draft = null;
        editor.replaceChildren();
        notify('工作流已保存');
        await refresh();
      } catch (cause) {
        conflict.textContent = `${cause}。编辑内容仍保留。`;
        retry.hidden = !String(cause).includes('其他窗口');
      } finally { save.disabled = false; }
    });
    editor.replaceChildren(form);
    title.focus();
  }

  subscribe(value => {
    view = value;
    error.textContent = value.workspaceError || '';
    const key = JSON.stringify([value.workspace, value.tasks.map(task => [task.workflowId, task.stageId])]);
    if (listKey === key) return;
    listKey = key;
    list.replaceChildren();
    if (!value.workspace?.workflows.length && !value.workspaceError) list.append(element('p', 'hint', '还没有工作流。创建后可获取进度文件接入模板。'));
    for (const flow of value.workspace?.workflows || []) {
      const card = element('article', 'workflow-card');
      card.append(element('h3', '', `${flow.title}${flow.paused ? ' · 已暂停' : ''}`), element('p', 'path', flow.root || '未关联项目目录'));
      for (const stage of flow.stages) {
        const count = value.tasks.filter(task => task.workflowId === flow.id && task.stageId === stage.id).length;
        card.append(element('p', 'hint', `${stage.label} · ${count} 个任务`));
      }
      card.append(button('编辑', () => edit(flow)), button(flow.paused ? '恢复观察' : '暂停观察', async () => {
        await call('workflowPause', { id: flow.id, paused: !flow.paused, expectedRevision: view.workspace.revision }); await refresh();
      }), button('接入模板', async () => {
        const result = await call('workflowPrompt', { id: flow.id });
        const text = element('textarea');
        text.readOnly = true;
        text.value = result.prompt;
        text.setAttribute('aria-label', `${flow.title}的接入模板`);
        prompt.replaceChildren(element('h3', '', '复制给当前项目的 Agent'), text, button('复制模板', () => native('plugin:clipboard-manager|write_text', { text: result.prompt })), button('收起模板', () => prompt.replaceChildren()));
      }), button('删除', async () => {
        if (!window.confirm(`删除工作流「${flow.title}」？来源和进度文件继续保留。`)) return;
        await call('workflowDelete', { id: flow.id, expectedRevision: view.workspace.revision }); await refresh();
      }));
      list.append(card);
    }
  });
}
