// How every view names a job's model. No imports: the Claude Code mod
// (hooks/mod.ts), which has no Node, uses it as the live view and digest do.

// OpenCode reports models as { providerID, id, variant }; others as strings.
export const modelName = model => model && typeof model === 'object'
  ? [model.providerID, model.id].filter(Boolean).join('/') + (model.variant && model.variant !== 'default' ? `#${model.variant}` : '') || JSON.stringify(model)
  : model;

// The model and effort a job runs on: the result's, else the latest the
// companion reported, else the selection. Raw strings; the caller cleans them.
export function jobModel(job, result = null) {
  const progress = job.progress ?? {};
  return [modelName(result?.effectiveModel ?? progress.effectiveModel ?? job.effectiveModel ?? job.modelOverride),
    result?.effectiveEffort ?? progress.effectiveEffort ?? job.effectiveEffort ?? job.effortOverride].filter(Boolean).map(String);
}
