import { controlSchemaManifest, packagedMigrations } from '@alpacawork/db';
process.stdout.write(JSON.stringify({ control: controlSchemaManifest(), host: packagedMigrations('host') }) + '\n');
