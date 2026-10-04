import { startService } from '@ijime/service-kit';

import { createApp, SERVICE_NAME } from './app.js';

startService(createApp(), SERVICE_NAME);
