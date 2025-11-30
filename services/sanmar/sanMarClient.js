const soap = require('soap')

async function getSanmarClient(wsdlUrl) {
    const client = await soap.createClientAsync(wsdlUrl);
    const auth = "Basic " +  Buffer.from(
        `${process.env.SANMAR_USER}:${process.env.SANMAR_PASS}`
    ).toString("base64");
    
client.addHttpHeader("Authorization",auth);
return client;
}

module.exports = getSanmarClient;