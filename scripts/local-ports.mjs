export function localPorts(env = process.env) {
  const offset = Number(env.LOCAL_PORT_OFFSET ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 50_000) {
    throw new Error('LOCAL_PORT_OFFSET must be an integer between 0 and 50000');
  }
  return {
    child: 3100 + offset,
    guardian: 3101 + offset,
    api: 8080 + offset,
    pet: 8082 + offset,
    voice: 8083 + offset,
    firestore: 8095 + offset,
    hub: 4405 + offset,
    logging: 4505 + offset,
  };
}

export function localEnvironment(env = process.env) {
  const ports = localPorts(env);
  const dist = env.NEXT_DIST_DIR ?? `.next/local-${ports.child}`;
  if (!/^\.next\/local-[a-zA-Z0-9_-]+$/.test(dist)) {
    throw new Error(
      'Local NEXT_DIST_DIR must be .next/local-<name> so local builds never replace the deploy build',
    );
  }
  return {
    NEXT_DIST_DIR: dist,
    NEXT_PUBLIC_LOCAL_DEMO: '1',
    NEXT_PUBLIC_API_BASE_URL: `http://localhost:${ports.api}`,
    NEXT_PUBLIC_VOICE_WS_URL: `ws://localhost:${ports.voice}`,
  };
}
