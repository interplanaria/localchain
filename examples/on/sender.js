const datapay = require('datapay')
const Localchain = require('../../index')
const chain = new Localchain()
const buildTx = (i) => {
  return new Promise((resolve, reject) => {
    datapay.build({
      data: [Date.now().toString(), i.toString()]
    }, async (err, tx) => {
      if (err) {
        reject(err)
      } else {
        resolve(tx.toString())
      }
    })
  })
};
(async () => {
  for (let j=0; j<10; j++) {
    let tx = await buildTx(j)
    for (let i=0; i<10; i++) {
      await chain.post({
        payment: { transaction: tx },
        path: i.toString()
      })
      .catch((e) => {
        console.log(e)
      })
    }
  }
})();
