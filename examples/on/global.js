const Localchain = require("../../index")
const chain = new Localchain();
chain.on("*", (e) => {
  console.log("event", e)
})
