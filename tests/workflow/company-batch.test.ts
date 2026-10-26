import { expect, it } from 'vitest';
import { fixtureDatabase } from './database.js';
import { jobId } from '../intelligence/fixtures.js';
import { SqlAnalysisQueue } from '../../src/workflow/analysis.js';
import type { Database, SqlExecutor } from '../../src/shared/ports.js';

it('loads a hundred-company analysis directory with one evidence read and unchanged source-validity filtering', async () => {
  const db = await fixtureDatabase();
  try {
    const companies = (await db.query("INSERT INTO companies(canonical_name) SELECT 'Synthetic directory '||n FROM generate_series(1,100) n RETURNING id")).rows;
    await db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text,version) VALUES(-1001,2,7,now(),'Edited source',2)");
    await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1002,'group','Excluded synthetic source','excluded')");
    await db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text) VALUES(-1002,1,7,now(),'Excluded source')");
    const evidence = (await db.query("INSERT INTO evidence(chat_id,message_id,message_version,excerpt,observed_at) VALUES(-1001,1,1,'Current source',now()),(-1001,2,1,'Stale source',now()),(-1002,1,1,'Excluded source',now()) RETURNING id")).rows;
    for (let i = 0; i < 3; i++) await db.query('INSERT INTO company_evidence(company_id,evidence_id) VALUES($1,$2)', [companies[i]!.id,evidence[i]!.id]);
    let evidenceReads = 0;
    const counted: Database = { ...db, transaction: (work) => db.transaction((tx) => work({ query: ((sql, values) => {
      if (sql.includes('FROM company_evidence')) evidenceReads++;
      return tx.query(sql, values);
    }) as SqlExecutor['query'] })) };
    const input = await new SqlAnalysisQueue(counted).loadInput(jobId);
    expect(input.companies).toHaveLength(100); expect(evidenceReads).toBe(1);
    expect(input.companies.find((c) => c.id === companies[0]!.id)!.evidenceIds).toEqual([evidence[0]!.id]);
    expect(input.companies.find((c) => c.id === companies[1]!.id)!.evidenceIds).toEqual([]);
    expect(input.companies.find((c) => c.id === companies[2]!.id)!.evidenceIds).toEqual([]);
  } finally { await db.close(); }
});
