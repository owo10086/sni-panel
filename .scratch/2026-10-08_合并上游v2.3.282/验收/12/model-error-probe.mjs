import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { z } = createRequire('/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/package.json')('zod');
import { ForwardxAiClient, AiClientError } from '/Users/macmini/Documents/Aixiaoji/haproxy-sni/Forwardx/server/ai/client.ts';
const probeSecret='synthetic-ticket12-api-secret';
const settings={enabled:true,apiKey:probeSecret,provider:'custom',model:'test',chatCompletionsUrl:'https://test.invalid/v1/chat/completions'};
const client=new ForwardxAiClient({transientRetries:0,fetchImpl:async()=>new Response(`Upstream rejected Authorization: Bearer ${probeSecret}`,{status:401})});
try {
 await client.requestStructuredJson({operation:'ticket12.error',settings,systemPrompt:'s',userText:'u',schema:z.object({ok:z.boolean()})});
 assert.fail('expected provider rejection');
} catch(error) {
 assert.ok(error instanceof AiClientError);
 console.log(JSON.stringify({httpStatus:error.options.status,exposesSyntheticSecret:error.message.includes(probeSecret),hasDiagnostic:error.message.includes('401')}));
}
