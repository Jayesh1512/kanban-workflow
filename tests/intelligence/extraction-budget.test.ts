import{expect,it,vi}from'vitest';
import{extractionTimeoutMs}from'../../src/intelligence/extraction-budget.js';
import{ProviderHttp}from'../../src/intelligence/http.js';
import{createOpenAIExtractor}from'../../src/intelligence/openai.js';
import{inputFixture}from'./fixtures.js';

it.each([[90000,47999,90000],[90000,48000,180000],[300000,100000,300000]])('bounds timeout for configured %s and payload %s', (configured,size,want)=>{expect(extractionTimeoutMs(configured!,size!)).toBe(want);});
it('uses the configured timeout for ordinary HTTP calls and an explicit override only when requested',async()=>{
  const observed:number[]=[],original=AbortSignal.timeout.bind(AbortSignal);
  const spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{observed.push(ms);return original(2);});
  const transport:typeof fetch=async(_url,init)=>{await new Promise<void>((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('Synthetic timeout')),{once:true}));throw Error('unreachable');};
  try{const h=new ProviderHttp({apiKey:'synthetic-key',timeoutMs:20,maxAttempts:1},{fetch:transport});expect(await h.post('https://example.invalid',{})).toMatchObject({ok:false,code:'timeout'});expect(await h.post('https://example.invalid',{},undefined,180000)).toMatchObject({ok:false,code:'timeout'});expect(observed).toEqual([20,180000]);}finally{spy.mockRestore();}
});
it('the real extractor selects the long budget only for a large serialized context',async()=>{
  const observed:number[]=[],original=AbortSignal.timeout.bind(AbortSignal),spy=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{observed.push(ms);return original(2);});
  const transport:typeof fetch=async(_url,init)=>{await new Promise<void>((_,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('Synthetic timeout')),{once:true}));throw Error('unreachable');};
  try{const model=createOpenAIExtractor({provider:'openai',model:'gpt-6.1-sol',apiKey:'synthetic-key',timeoutMs:25,maxAttempts:1,maxOutputTokens:8192},{fetch:transport}),input=inputFixture();await model.extract(input);input.messages[0]!.text='Long synthetic context '.repeat(4000);input.evidence[0]!.excerpt=input.messages[0]!.text;await model.extract(input);expect(observed).toEqual([25,180000]);}finally{spy.mockRestore();}
});
it('cancelled requests remain durably retryable but never issue an in-process retry after abort',async()=>{
  const abort=new AbortController();let calls=0;
  const transport:typeof fetch=async()=>{calls++;throw Error('Synthetic cancellation');};abort.abort();
  const result=await new ProviderHttp({apiKey:'synthetic-key',timeoutMs:1000,maxAttempts:3},{fetch:transport}).post('https://example.invalid',{},abort.signal);
  expect(result).toMatchObject({ok:false,code:'timeout',retryable:true,detail:'Provider request cancelled'});expect(calls).toBe(1);
});
