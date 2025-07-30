# Whatsapp Baileys

This project allows sending a Whatsapp message through a connected device.

It is expected to run on a cloud provider that supports Express, for example, render.com .

In order to protect the service, two paths need to receive the JWT token on the authentication header.

## How to create a random JWT secret to start the service

`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## The following paths are available
- `GET /health` it's used to weak up the service in case it's been suspended.
- `GET /qr` it's used to present the QR code to link the service with the Whatsapp account. NOTE: you need to manually inject the Authorization header.
- `POST /send` it's used to send a message to a recipient.

## Generate the JWT token manually
1. Access https://jwt.io/
2. Go to the JWT Encode feature
3. On valid header use
```
{
  "alg": "HS256",
  "typ": "JWT",
  "exp": "5m"
}
```
4. On payload use
```
{
  "sub": "franco"
}
```
5. On the secret area use the secret matching the one configured on the service.

## Whastapp credentials storage
This project stores the credentials into a Cloudflare R2 Object Storage.

## Sample API call to send a message
```
curl -X POST http://localhost:10000/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer XXXXXX" \
  -d '{
    "jid": "999999@g.us",
    "message": "🎉 Happy Birthday from the server!"
  }'
```
