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
it.each(['phone','role','identity','date','evidence'] as const)('never uses name normalization to accept an unsupported %s',kind=>{
  const input=inputFixture(),raw=extractionFixture();raw.contacts[0]!.names.push('Invented Unseen Alias');
  if(kind==='phone')raw.contacts[0]!.phones=['+99999999999'];if(kind==='role')raw.contacts[0]!.roles[0]!.role='UnseenRole';if(kind==='identity')raw.contacts[0]!.telegramUserIds=['123456'];if(kind==='date')raw.facts[0]!.dates[0]!.localDate='1999-01-01';if(kind==='evidence')raw.evidenceIds=['00000000-0000-4000-8000-999999999999'];
  expect(()=>normalizeExtraction(raw,input)).toThrow();
});
it.each(['internal','external'] as const)('abstains on unsupported %s affiliation while preserving sourced identity and facts',affiliation=>{
  const input=inputFixture(),raw=extractionFixture();raw.contacts[0]!.affiliation=affiliation;
  if(affiliation==='external'){input.messages[0]!.text='Hello, nice to meet you.';input.evidence[0]!.excerpt=input.messages[0]!.text;raw.companies=[];raw.companyCandidates=[];raw.facts=[];raw.dates=[];raw.contacts[0]!.roles=[];}
  expect(()=>validateExtraction(raw,input)).toThrow('affiliation');
  const result=normalizeExtraction(raw,input);expect(result.omittedContactAffiliations).toBe(1);expect(result.value.contacts[0]!).toEqual({...raw.contacts[0]!,affiliation:'unknown'});expect(result.value.facts).toEqual(raw.facts);expect(()=>validateExtraction(result.value,input)).not.toThrow();expect(raw.contacts[0]!.affiliation).toBe(affiliation);
});
it('removing an unsupported affiliation never admits an unrelated identity, role, phone or date',()=>{
  for(const kind of ['identity','role','phone','date']){const input=inputFixture(),raw=extractionFixture();raw.contacts[0]!.affiliation='internal';
    if(kind==='identity')raw.contacts[0]!.telegramUserIds=['123456'];if(kind==='role')raw.contacts[0]!.roles[0]!.role='UnseenRole';if(kind==='phone')raw.contacts[0]!.phones=['+99999999999'];if(kind==='date')raw.facts[0]!.dates[0]!.localDate='1999-01-01';expect(()=>normalizeExtraction(raw,input)).toThrow();}
});
it('retains valid external affiliation when an unrelated unsupported name alias is removed',()=>{
  const input=inputFixture(),raw=extractionFixture();raw.contacts[0]!.names.push('Invented Alias');const result=normalizeExtraction(raw,input);expect(result.value.contacts[0]!.affiliation).toBe('external');expect(result.omittedContactAffiliations).toBe(0);
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
it('omits unsupported optional company attributes while retaining sourced primary company identity and facts',()=>{
 const input=inputFixture(),raw=extractionFixture();const company=raw.companies[0]!;
 company.aliases.push('Unsupported invented brand expansion');company.domains.push('invented.example');company.buyerIds.push('invented-buyer');company.providerIds.push('invented-provider');
 expect(()=>validateExtraction(raw,input)).toThrow('Company attribute absent');const result=normalizeExtraction(raw,input);expect(result.omittedCompanyAttributes).toBe(4);expect(result.value).toEqual(extractionFixture());expect(raw.companies[0]!.aliases).toContain('Unsupported invented brand expansion');expect(()=>validateExtraction(result.value,input)).not.toThrow();
});
it('optional company cleanup never admits unsupported primary names, evidence, contacts, dates or roles',()=>{
 for(const kind of ['name','evidence','identity','phone','role','date']){const input=inputFixture(),raw=extractionFixture();raw.companies[0]!.aliases.push('Invented Alias');
  if(kind==='name')raw.companies[0]!.canonicalName='Invented Company';if(kind==='evidence')raw.companies[0]!.evidenceIds=['00000000-0000-4000-8000-999999999999'];if(kind==='identity')raw.contacts[0]!.telegramUserIds=['9999'];if(kind==='phone')raw.contacts[0]!.phones=['+99999999999'];if(kind==='role')raw.contacts[0]!.roles[0]!.role='Invented Role';if(kind==='date')raw.facts[0]!.dates[0]!.localDate='1999-01-01';expect(()=>normalizeExtraction(raw,input)).toThrow();}
});
