const config = {
  db_name: ''
};

function setDynamicConfig(key, value) {
  config[key] = value;
}

module.exports = {
  setDynamicConfig
};

