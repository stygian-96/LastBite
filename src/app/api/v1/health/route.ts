import { route } from '@/lib/http';

export const GET = route({}, async () => ({ status: 'ok' }));
