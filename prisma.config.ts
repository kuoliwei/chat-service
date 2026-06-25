import { PrismaClient } from '@prisma/client';
import { LibsqlClient, createClient } from '@libsql/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';

const libsql: LibsqlClient = createClient({
  url: `file:${process.cwd()}/prisma/dev.db`,
});

const adapter = new PrismaLibSQL(libsql);
export const prisma = new PrismaClient({ adapter });
