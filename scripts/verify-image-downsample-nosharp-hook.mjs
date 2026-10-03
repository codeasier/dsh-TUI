/**
 * 一次性 loader 钩子：只给 verify-image-downsample 的 sharp-missing 子进程用。
 *
 * sharp 是 optionalDependency。共享加载器会先解析候选，再 import 绝对入口；
 * 钩子同时拒绝裸 specifier 与候选入口，模拟宿主和本地都没有可加载的 sharp。
 * loadSharp() 因而返回 undefined。子进程由 scripts/verify-image-downsample.tsx 通过
 * DSH_VERIFY_IMAGE_NOSHARP=1 启动。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sharp' || /[/\\]sharp[/\\]/u.test(specifier)) {
    throw new Error('sharp is not installed in this environment (simulated)')
  }
  return nextResolve(specifier, context)
}
