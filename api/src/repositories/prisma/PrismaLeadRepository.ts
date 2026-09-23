import type { PrismaClient } from "@prisma/client";
import type { Lead } from "../../domain/models";
import type { LeadStatus } from "../../lib/constants";
import type { LeadFields, LeadFilter, LeadRepository } from "../LeadRepository";
import { toLead } from "./mappers";

export class PrismaLeadRepository implements LeadRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findMany(filter: LeadFilter): Promise<Lead[]> {
    const rows = await this.prisma.lead.findMany({
      // undefined keys are ignored by Prisma, so absent filters match everything
      where: { status: filter.status, source: filter.source },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toLead);
  }

  async findById(id: number): Promise<Lead | null> {
    const row = await this.prisma.lead.findUnique({ where: { id } });
    return row ? toLead(row) : null;
  }

  async findConvertedWithoutEvent(): Promise<Lead[]> {
    const rows = await this.prisma.lead.findMany({
      where: { status: "converted", conversionEvents: { none: {} } },
    });
    return rows.map(toLead);
  }

  async create(fields: LeadFields): Promise<Lead> {
    return toLead(await this.prisma.lead.create({ data: { ...fields, status: "new" } }));
  }

  async update(id: number, fields: LeadFields): Promise<Lead> {
    return toLead(await this.prisma.lead.update({ where: { id }, data: fields }));
  }

  async updateStatus(id: number, status: LeadStatus): Promise<Lead> {
    return toLead(await this.prisma.lead.update({ where: { id }, data: { status } }));
  }

  async delete(id: number): Promise<void> {
    await this.prisma.lead.delete({ where: { id } });
  }
}
