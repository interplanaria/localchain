const Localchain = require("../../index")
const chain = new Localchain();
chain.on("1", (e) => {
  console.log(e)
})
