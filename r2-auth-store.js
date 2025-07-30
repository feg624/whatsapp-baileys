const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3')

const {
  initAuthCreds,
  BufferJSON,
  proto,
} = require('@whiskeysockets/baileys')

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
})

const useCloudflareR2AuthState = async () => {
  const writeData = async (data, key) => {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: JSON.stringify(data, BufferJSON.replacer),
      ContentType: 'application/json',
    }))
  };
  const readData = async (key) => {
    try {
      const res = await s3.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }))
      const data = await res.Body.transformToString()
      return JSON.parse(data, BufferJSON.reviver)
    } catch (err) {
      if (err.name === 'NoSuchKey') {
        return undefined
      }
      throw err
    }
  };
  const removeData = async (key) => {
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }))
  };
  const clear = async () => {
    await removeData('creds.json')
  };
  const creds = await readData('creds.json') || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      return writeData(creds, 'creds.json');
    },
    clearCreds: async () => {
      return clear();
    },
  };
};

module.exports = { useCloudflareR2AuthState }
