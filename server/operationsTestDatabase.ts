/** Tests accept only the disposable local PostgreSQL used by this rehearsal and CI. */
export function isolatedOperationsDatabase() { const value = process.env.OPS_REHEARSAL_DB ?? 'postgresql://postgres@127.0.0.1:55446/ops_rehearsal'; const u = new URL(value); if (u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' || u.port !== '55446' || u.username !== 'postgres' || !['/ops_rehearsal', '/ops_ci'].includes(u.pathname) || u.password || u.search)
    throw Error('Disposable loopback database required'); return value; }
