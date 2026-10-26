import type {AnalysisInput,Extraction} from '../shared/domain.js';
import {extractionSchema,validateExtraction} from './validation.js';

const recoverableContactError=(error:unknown)=>error instanceof Error&&['Contact name absent from target identity evidence','Internal affiliation lacks identity-attributed AntSeed evidence','External affiliation lacks identity-attributed company evidence'].includes(error.message);

/** Omit unsupported optional names and abstain on unsourced affiliation. Identity, phones,
 * roles, facts, dates and all retained fields remain strict.
 * Every retained field is run through the unchanged validator again. */
export function normalizeExtraction(raw:unknown,input:AnalysisInput):{value:Extraction;omittedContactNames:number;omittedContactAffiliations:number;omittedCompanyAttributes:number;omittedKnownCompanyRecords:number}{
  // Optional aliases/domains/IDs may be omitted when unsupported. Primary
  // company identity and every retained attribute still pass the strict validator.
  const parsed=extractionSchema.parse(raw);let omittedCompanyAttributes=0,omittedKnownCompanyRecords=0;
  const known=input.chat.mappingStatus==='confirmed'?input.companies.find(c=>c.id===input.chat.companyId):undefined;
  const source={...parsed,companies:parsed.companies.filter(company=>{
    // A metadata-confirmed company is already linked. If the model repeats
    // that exact name as a supposed message extraction, abstain on the record;
    // never fabricate a quote or relax validation for any retained claim.
    const quotes=company.evidenceIds.map(id=>input.evidence.find(e=>e.id===id)?.excerpt??'');
    if(known&&company.canonicalName.toLowerCase()===known.canonicalName.toLowerCase()&&!quotes.some(q=>q.toLowerCase().includes(company.canonicalName.toLowerCase()))){
      // Invalid evidence must still fail even when this redundant record is omitted.
      validateExtraction({...parsed,companies:[],companyCandidates:[],contacts:[],facts:[],dates:[],substantive:true,evidenceIds:company.evidenceIds},input);
      omittedKnownCompanyRecords++;return false;
    }
    return true;
  }).map(company=>{
    const quotes=company.evidenceIds.map(id=>input.evidence.find(e=>e.id===id)?.excerpt??'').join('\n');
    const keep=(values:string[],fold:boolean)=>values.filter(value=>{const supported=fold?quotes.toLowerCase().includes(value.toLowerCase()):quotes.includes(value);if(!supported)omittedCompanyAttributes++;return supported;});
    return {...company,aliases:keep(company.aliases,true),domains:keep(company.domains,true),buyerIds:keep(company.buyerIds,false),providerIds:keep(company.providerIds,false)};
  })};
  try{return{value:validateExtraction(source,input),omittedContactNames:0,omittedContactAffiliations:0,omittedCompanyAttributes,omittedKnownCompanyRecords};}
  catch(error){if(!recoverableContactError(error))throw error;}
  if(source.contacts.reduce((n,c)=>n+c.names.length,0)>256)throw new Error('Contact-name normalization exceeds bounded limit');
  validateExtraction({...source,contacts:[]},input);
  let omittedContactNames=0,omittedContactAffiliations=0;
  const contacts=source.contacts.map(contact=>{
    try{validateExtraction({...source,contacts:[contact]},input);return contact;}
    catch(error){if(!recoverableContactError(error))throw error;}
    const candidate={...contact,names:[] as string[],affiliation:'unknown' as const};
    validateExtraction({...source,contacts:[candidate]},input);
    for(const name of contact.names){
      try{validateExtraction({...source,contacts:[{...candidate,names:[...candidate.names,name]}]},input);candidate.names.push(name);}
      catch(error){if(!(error instanceof Error)||error.message!=='Contact name absent from target identity evidence')throw error;omittedContactNames++;}
    }
    // Restore the original affiliation only if it independently passes the
    // strict validator with the retained names. Unknown never asserts a company.
    const restored={...candidate,affiliation:contact.affiliation};
    try{validateExtraction({...source,contacts:[restored]},input);return restored;}
    catch(error){if(!(error instanceof Error)||!['Internal affiliation lacks identity-attributed AntSeed evidence','External affiliation lacks identity-attributed company evidence'].includes(error.message))throw error;}
    omittedContactAffiliations++;
    return candidate;
  });
  return{value:validateExtraction({...source,contacts},input),omittedContactNames,omittedContactAffiliations,omittedCompanyAttributes,omittedKnownCompanyRecords};
}

/** Keep all source text/metadata and versioned evidence IDs, without sending a
 * second copy of an excerpt that is identical to its referenced message body. */
export function extractionPromptInput(input:AnalysisInput){
  return{...input,evidence:input.evidence.map(e=>{
    const message=input.messages.find(m=>m.chatId===e.chatId&&m.id===e.messageId&&m.version===e.messageVersion);
    if(!message||e.excerpt!==message.text)return e;
    const {excerpt:_,...reference}=e;return reference;
  })};
}
