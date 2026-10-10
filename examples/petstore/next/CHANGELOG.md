## Swagger Petstore 1.0.0 → 1.1.0

**5 breaking changes**, 7 non-breaking changes.

### Breaking changes

- **`GET /pets`** (`listPets`): query parameter `limit` is now required.
- **`GET /pets/{id}`** (`showPetById`): path parameter `petId` was renamed to `id`.
- **`PATCH /pets/{id}`** (`updatePet`): path parameter `petId` was renamed to `id`.
- **`DELETE /pets/{petId}`** (`deletePet`): endpoint removed (it was deprecated).
- **Schema `PetStatus`** (used by `GET /pets`, `POST /pets`, `GET /pets/{id}` and 3 more): enum value `archived` was added.

### Non-breaking changes

- **`GET /store/inventory`** (`getInventory`): authentication changed from `apiKey` to `apiKey` or `bearerAuth`.
- **`GET /store/orders`** (`listOrders`): endpoint added.
- **`GET /health`** (`healthCheck`)
  - Response `200`: now uses `Health` instead of an inline schema.
- **Schema `NewPet`** (used by `GET /pets`, `POST /pets`, `GET /pets/{id}` and 3 more): optional property `birthDate` was added.
- **Schema `Order`** (used by `GET /store/orders`, `GET /store/orders/{orderId}`): enum value `delivered` was removed from `status`.
- **Schema `Health`** (used by `GET /health`): added.
- **API**: default server URL changed from `https://petstore.example.com/v1` to `https://petstore.example.com/v2`.
