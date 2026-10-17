import type {AnalysisInput,Extraction} from '../shared/domain.js';
import {extractionSchema,validateExtraction} from './validation.js';

/** Omit only an unsupported optional display-name alias. Identity, phones,
 * roles, affiliations, facts, dates and all other source checks remain strict.
 * Every retained field is run through the unchanged validator again. */
export function normalizeExtraction(raw:unknown,input:AnalysisInput):{value:Extraction;omittedContactNames:number}{
  try{return{value:validateExtraction(raw,input),omittedContactNames:0};}
  catch(error){if(!(error instanceof Error)||error.message!=='Contact name absent from target identity evidence')throw error;}
  const parsed=extractionSchema.parse(raw);
  if(parsed.contacts.reduce((n,c)=>n+c.names.length,0)>256)throw new Error('Contact-name normalization exceeds bounded limit');
  validateExtraction({...parsed,contacts:[]},input);
  let omittedContactNames=0;
  const contacts=parsed.contacts.map(contact=>{
    try{validateExtraction({...parsed,contacts:[contact]},input);return contact;}
    catch(error){if(!(error instanceof Error)||error.message!=='Contact name absent from target identity evidence')throw error;}
    const candidate={...contact,names:[] as string[]};
    validateExtraction({...parsed,contacts:[candidate]},input);
    for(const name of contact.names){
      try{validateExtraction({...parsed,contacts:[{...candidate,names:[...candidate.names,name]}]},input);candidate.names.push(name);}
      catch(error){if(!(error instanceof Error)||error.message!=='Contact name absent from target identity evidence')throw error;omittedContactNames++;}
    }
    return candidate;
  });
  return{value:validateExtraction({...parsed,contacts},input),omittedContactNames};
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
