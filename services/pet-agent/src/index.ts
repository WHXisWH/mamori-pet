import { startService } from '@ijime/service-kit';

import { createApp, SERVICE_NAME } from './app.js';
import { createRuntime, type PetRuntime } from './runtime.js';

let runtime: Promise<PetRuntime> | undefined;
const getRuntime = () => (runtime ??= createRuntime());

startService(createApp(getRuntime), SERVICE_NAME);
