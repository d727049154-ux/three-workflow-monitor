'use strict';
const methods = new Set([
  'current', 'refresh', 'refreshAll', 'checkpoint', 'history', 'snapshot', 'verify', 'export',
  'configure', 'openData', 'openProject', 'openSource', 'openThread', 'openTaskProject',
  'catalog', 'catalogRefresh', 'catalogExport', 'catalogOpen', 'workspaceState',
  'quickFavorite', 'quickVisit', 'activity', 'activitySeen', 'workflowSave', 'workflowPause',
  'workflowPrompt', 'managerOpen', 'resourceSave', 'resourcePause', 'workspaceExport',
  'dockCurrent', 'dockRefresh', 'dockHistory', 'dockSnapshot', 'dockExport', 'dockOpenThread',
  'dockArtifacts', 'dockOpenArtifact'
]);
const commands = new Set(['info', 'pin', 'compact', 'hide', 'menu', 'quit', 'dockShow', 'dockHide', 'dockExpand', 'dockCollapse', 'dockPanel', 'dockLeft', 'dockRight']);
function validateCall(input) {
  if (!input || !methods.has(input.method)) throw new Error('此操作不在工作流观察的接口范围内');
  const args = input.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 32768) {
    throw new Error('操作参数无效或过长');
  }
  return {method: input.method, args};
}
function validateCommand(command) {
  if (!commands.has(command)) throw new Error('未知窗口操作');
  return command;
}
module.exports = {validateCall, validateCommand};
