// Synthetic wire-contract fixture. Not evidence of model accuracy.
// Source: https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create
require('node:http').createServer((req,res)=>{
 res.setHeader('Content-Type','application/json');
 const send=(code,value)=>{res.statusCode=code;res.end(JSON.stringify(value));};
 if(req.method!=='POST'||req.url!=='/v1/decisions')return send(501,{error:{message:'Not modeled'}});
 const b=req.body;
 if(b?.model!=='gpt-6-luna'||typeof b.input!=='string'||!Array.isArray(b.questions))return send(400,{error:{message:'Expected native Decisions request'}});
 const picks={relevance:'company',company_match:'new_company',workstream:'Buyer',lane:'no_change'};
 const answers=b.questions.map(q=>q.type==='predicate'?{name:q.name,type:'predicate',probability:0.01}:q.type==='choice'?{name:q.name,type:'choice',choice:picks[q.name],confidence:1,probabilities:q.choices.map(c=>({value:c.value,probability:c.value===picks[q.name]?1:0}))}:{name:q.name,type:'score',score:1,confidence:1,probabilities:q.levels.map((l,i)=>({value:i,label:l.label,probability:i===1?1:0}))});
 res.setHeader('x-request-id','synthetic-decisions-simulation');send(200,{model:b.model,answers,usage:{input_tokens:100,output_tokens:0}});
}).listen(process.env.PORT);
