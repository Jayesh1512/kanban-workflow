import{expect,it}from'vitest';
import{extractionPromptInput,normalizeExtraction}from'../../src/intelligence/extraction-normalization.js';
import{validateExtraction}from'../../src/intelligence/validation.js';
import{extractionFixture,inputFixture}from'./fixtures.js';

it('drops an invented optional alias while retaining the exact sourced identity and valid contact attributes',()=>{
  const input=inputFixture(),raw=extractionFixture();raw.contacts[0]!.names.push('Invented Unseen Alias');
  expect(()=>validateExtraction(raw,input)).toThrow('Contact name');
  const n=normalizeExtraction(raw,input);expect(n.omittedContactNames).toBe(1);expect(n.value).toEqual(extractionFixture());expect(raw.contacts[0]!.names).toHaveLength(2);expect(()=>validateExtraction(n.value,input)).not.toThrow();
});
it('can preserve a source-bound ID with an unknown display name instead of inventing a replacement',()=>{
  const input=inputFixture(),raw=extractionFixture();raw.contacts[0]!.names=['Invented Unseen Alias'];raw.contacts[0]!.roles=[];raw.contacts[0]!.affiliation='unknown';
  expect(normalizeExtraction(raw,input)).toMatchObject({omittedContactNames:1,value:{contacts:[{telegramUserIds:['7'],names:[],usernames:['mira']}]}});
});
it.each(['phone','role','identity','affiliation','date','evidence'] as const)('never uses name normalization to accept an unsupported %s',kind=>{
  const input=inputFixture(),raw=extractionFixture();raw.contacts[0]!.names.push('Invented Unseen Alias');
  if(kind==='phone')raw.contacts[0]!.phones=['+99999999999'];if(kind==='role')raw.contacts[0]!.roles[0]!.role='UnseenRole';if(kind==='identity')raw.contacts[0]!.telegramUserIds=['123456'];if(kind==='affiliation')raw.contacts[0]!.affiliation='internal';if(kind==='date')raw.facts[0]!.dates[0]!.localDate='1999-01-01';if(kind==='evidence')raw.evidenceIds=['00000000-0000-4000-8000-999999999999'];
  expect(()=>normalizeExtraction(raw,input)).toThrow();
});
it('omits duplicate excerpts only when exact source text and version match, preserving all messages and original input',()=>{
  const input=inputFixture(),wire=extractionPromptInput(input);expect(wire.messages).toEqual(input.messages);expect(wire.evidence[0]).not.toHaveProperty('excerpt');expect(wire.evidence[0]).toMatchObject({id:input.evidence[0]!.id,messageId:1,messageVersion:1});expect(input.evidence[0]!.excerpt).toBe(input.messages[0]!.text);expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(input).length);
  input.evidence[0]!.excerpt='Partial quoted excerpt';expect(extractionPromptInput(input).evidence[0]).toHaveProperty('excerpt','Partial quoted excerpt');
  input.evidence[0]!.excerpt=input.messages[0]!.text;input.evidence[0]!.messageVersion=2;expect(extractionPromptInput(input).evidence[0]).toHaveProperty('excerpt',input.messages[0]!.text);
});
it('bounds recovery work for a malformed response with hundreds of optional names',()=>{
  const input=inputFixture(),raw=extractionFixture();raw.contacts=Array.from({length:3},()=>({...raw.contacts[0]!,names:Array.from({length:100},(_,i)=>'Invented alias '+i)}));
  expect(()=>normalizeExtraction(raw,input)).toThrow('bounded limit');
});
