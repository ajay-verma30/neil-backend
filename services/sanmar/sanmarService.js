const getSanmarClient = require("./sanMarClient");

const WSDL_URL = process.env.SANMAR_WSDL;

async function getSanmarProducts(){
    try{
        const client = await getSanmarClient(WSDL_URL);
        const params = {
            UserName: process.env.SANMAR_USER,
            Password: process.env.SANMAR_PASS
        }

        const [result] = await client.GetProductListAsync(params);
        return result;
    }
    catch(err){
        console.error("Sanmar product fetch error :", err);
        throw err;
    }
}

module.exports = { getSanmarProducts };