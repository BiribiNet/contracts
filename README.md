# 🇺🇸 English

This repository contains the smart contracts and deployment scripts for the REUSD token, an upgradeable ERC20 token with role-based access control.

## Prerequisites

- Node.js (v16 or higher)
- Yarn package manager
- A wallet with sufficient ETH for deployment
- Tenderly account (for Tenderly deployments)

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd biribi
```

2. Install dependencies:
```bash
yarn install
```

3. Environment Setup:
   - Copy the `.env.example` file to create your `.env` file:
   ```bash
   cp .env.example .env
   ```
   - The default values are already set in the example file:
     - `CREATE2_ADDRESS`: The CREATE2 factory address
     - `CREATE2_ADMIN`: The admin address for CREATE2 factory
     - `SALT_IMPL`: Salt for implementation contract deployment (default: REUSD_IMPL)
     - `SALT_PROXY`: Salt for proxy contract deployment (default: REUSD_PROXY)
     - `CURRENCY`: The currency symbol to be used in the token name (default: USD)

   These salts, currency, and are used to generate deterministic addresses, token names, and for your contracts. If you want different addresses, salts, or currency, you can modify these values in your `.env` file.

4. Set up Hardhat environment variables:
```bash
# Set your private key
yarn hardhat vars set PRIVATE_KEY <your-private-key>

# Set RPC URLs for different networks
yarn hardhat vars set GNOSIS_RPC_URL <gnosis-rpc-url>
yarn hardhat vars set MAINNET_RPC_URL <mainnet-rpc-url>
yarn hardhat vars set SEPOLIA_RPC_URL <sepolia-rpc-url>
yarn hardhat vars set TENDERLY_RPC_URL <tenderly-rpc-url>
```

## Deployment Options

### Standard Deployments
```bash
# Deploy to Gnosis Chain
yarn deploy:gnosis

# Deploy to Sepolia Testnet
yarn deploy:sepolia

# Deploy using Tenderly
yarn deploy:tenderly
```

### Frame Deployments
# 🇫🇷 French

Ce dépôt contient les smart contracts et les scripts de déploiement pour le token REUSD, un token ERC20 évolutif avec contrôle d'accès basé sur les rôles.

## Prérequis

- Node.js (v16 ou supérieur)
- Gestionnaire de paquets Yarn
- Un portefeuille avec suffisamment d'ETH pour le déploiement
- Compte Tenderly (pour les déploiements Tenderly)

## Installation

1. Cloner le dépôt :
```bash
git clone <repository-url>
cd biribi
```

2. Installer les dépendances :
```bash
yarn install
```

3. Configuration de l'environnement :
   - Copier le fichier `.env.example` pour créer votre fichier `.env` :
   ```bash
   cp .env.example .env
   ```
   - Les valeurs par défaut sont déjà définies dans le fichier exemple :
     - `CREATE2_ADDRESS` : L'adresse du factory CREATE2
     - `CREATE2_ADMIN` : L'adresse admin pour le factory CREATE2
     - `SALT_IMPL` : Sel pour le déploiement du contrat d'implémentation (défaut : REUSD_IMPL)
     - `SALT_PROXY` : Sel pour le déploiement du contrat proxy (défaut : REUSD_PROXY)
     - `CURRENCY` : Le symbole de la devise à utiliser dans le nom du token (défaut : USD)

   Ces sels et la devise sont utilisés pour générer des adresses déterministes et des noms de tokens pour vos contrats. Si vous souhaitez des adresses ou des noms de tokens différents, vous pouvez modifier ces valeurs dans votre fichier `.env`.

4. Configurer les variables d'environnement Hardhat :
```bash
# Définir votre clé privée
yarn hardhat vars set PRIVATE_KEY <votre-clé-privée>

# Définir les URLs RPC pour différents réseaux
yarn hardhat vars set GNOSIS_RPC_URL <url-rpc-gnosis>
yarn hardhat vars set SEPOLIA_RPC_URL <url-rpc-sepolia>
yarn hardhat vars set TENDERLY_RPC_URL <url-rpc-tenderly>
```

## Options de Déploiement

### Déploiements Standards
```bash
# Déploiement sur Gnosis Chain
yarn deploy:gnosis

# Déploiement sur le Testnet Sepolia
yarn deploy:sepolia

# Déploiement avec Tenderly
yarn deploy:tenderly
```

### Déploiements avec Frame
Frame doit être en cours d'exécution et configuré avec le bon réseau avant d'utiliser ces options.

```bash
# Déploiement avec Frame sur différents réseaux
yarn deploy:frame:gnosis
yarn deploy:frame:mainnet
yarn deploy:frame:tenderly

# Déploiement du proxy uniquement (Gnosis)
yarn deploy:proxy:only
``` 