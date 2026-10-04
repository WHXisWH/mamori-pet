export function localMode(args, env = process.env) {
  if (args.length > 1 || (args.length === 1 && !['--real', '--manual'].includes(args[0])))
    throw new Error('Usage: node scripts/dev-local.mjs [--real|--manual]');
  if (env.NODE_ENV === 'production') throw new Error('Local preview cannot run in production');
  const real = args.length === 1;
  const manual = args[0] === '--manual';
  if (
    real &&
    (env.GCP_PROJECT_ID !== 'zenn-hackathon-510109' || env.REAL_BUSINESS_APPROVED !== '1')
  )
    throw new Error('Real preview requires the explicit test project and REAL_BUSINESS_APPROVED=1');
  return {
    name: manual ? 'manual' : real ? 'bounded' : 'scripted',
    real,
    manual,
    backend: manual
      ? ['scripts/manual-preview.mjs', '--run']
      : real
        ? ['scripts/real-preview.mjs', '--run']
        : ['scripts/local-backend.mjs'],
  };
}
