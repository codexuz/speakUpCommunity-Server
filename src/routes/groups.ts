import { Request, Response, Router } from 'express';
import { AuthenticatedRequest, authenticateRequest } from '../middleware/auth';
import prisma from '../prisma';
import { sseManager } from '../services/sse';

const router = Router();

router.use(authenticateRequest);

function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Helper: get user's membership in a group
async function getGroupMembership(groupId: string, userId: string) {
  return prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
}

// Helper: require a specific role in a group
async function requireGroupRole(
  groupId: string,
  userId: string,
  roles: string[],
  res: Response,
) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return null;
  }

  const membership = await getGroupMembership(groupId, userId);
  if (!membership || !roles.includes(membership.role)) {
    res.status(403).json({ error: 'You do not have permission for this action' });
    return null;
  }

  return { group, membership };
}

// ---------- List endpoints ----------

// GET /api/groups/my — current user's groups
router.get('/my', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const memberships = await prisma.groupMember.findMany({
      where: { userId: auth.userId },
      include: {
        group: {
          include: { _count: { select: { members: true } } },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    res.json(
      memberships.map((m: any) => ({
        ...m.group,
        member_count: m.group._count.members,
        myRole: m.role,
      })),
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/groups/teacher/:teacherId — backward compat for teacher's groups
router.get('/teacher/:teacherId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.userId !== (req.params.teacherId as string)) {
      res.status(403).json({ error: 'You do not have access to these groups' });
      return;
    }

    const memberships = await prisma.groupMember.findMany({
      where: { userId: auth.userId, role: { in: ['owner', 'teacher'] } },
      include: {
        group: {
          include: { _count: { select: { members: true } } },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    res.json(
      memberships.map((m: any) => ({
        ...m.group,
        member_count: m.group._count.members,
        myRole: m.role,
      })),
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/groups/student/:studentId — backward compat for student's groups
router.get('/student/:studentId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    if (auth.userId !== (req.params.studentId as string)) {
      res.status(403).json({ error: 'You do not have access to these groups' });
      return;
    }

    const memberships = await prisma.groupMember.findMany({
      where: { userId: auth.userId, role: 'student' },
      include: {
        group: {
          include: { _count: { select: { members: true } } },
        },
      },
    });

    res.json(
      memberships.map((m: any) => ({
        ...m.group,
        member_count: m.group._count.members,
      })),
    );
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Single group ----------

// GET /api/groups/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const membership = await getGroupMembership(req.params.id as string, auth.userId);
    if (!membership) {
      res.status(403).json({ error: 'You do not have access to this group' });
      return;
    }

    const group = await prisma.group.findUnique({
      where: { id: req.params.id as string },
      include: {
        creator: { select: { fullName: true, avatarUrl: true } },
        _count: { select: { members: true } },
      },
    });
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    res.json({ ...group, myRole: membership.role });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/groups/:id/members
router.get('/:id/members', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const membership = await getGroupMembership(req.params.id as string, auth.userId);
    if (!membership) {
      res.status(403).json({ error: 'You do not have access to this group' });
      return;
    }

    const members = await prisma.groupMember.findMany({
      where: { groupId: req.params.id as string },
      orderBy: { joinedAt: 'asc' },
      include: {
        user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
      },
    });

    res.json(members.map((m: any) => ({ ...m, id: m.id.toString() })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/groups/:id/submissions — speaking submissions for the group
router.get('/:id/submissions', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner', 'teacher'],
      res,
    );
    if (!result) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const members = await prisma.groupMember.findMany({
      where: { groupId: result.group.id },
      select: { userId: true },
    });
    const memberIds = members.map((m: any) => m.userId);

    if (memberIds.length === 0) {
      res.json({ data: [], pagination: { page, limit, total: 0, totalPages: 0 } });
      return;
    }

    const where = { studentId: { in: memberIds } };
    const [responses, total] = await Promise.all([
      prisma.response.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          student: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
          question: { select: { qText: true, part: true } },
        },
      }),
      prisma.response.count({ where }),
    ]);

    res.json({
      data: responses.map((r: any) => ({ ...r, id: r.id.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Group CRUD ----------

// POST /api/groups — create group (creator becomes owner)
router.post('/', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { name, description } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const referralCode = generateReferralCode();

    const group = await prisma.$transaction(async (tx) => {
      const g = await tx.group.create({
        data: { name, description, createdById: auth.userId, referralCode },
      });
      await tx.groupMember.create({
        data: { groupId: g.id, userId: auth.userId, role: 'owner' },
      });
      return g;
    });

    res.status(201).json(group);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/groups/:id — update (owner/teacher)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner', 'teacher'],
      res,
    );
    if (!result) return;

    const { name, description } = req.body;
    const group = await prisma.group.update({
      where: { id: result.group.id },
      data: { name, description },
    });

    res.json(group);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/groups/:id — owner only
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner'],
      res,
    );
    if (!result) return;

    await prisma.group.delete({ where: { id: result.group.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups/:id/regenerate-code — owner/teacher
router.post('/:id/regenerate-code', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner', 'teacher'],
      res,
    );
    if (!result) return;

    const newCode = generateReferralCode();
    await prisma.group.update({
      where: { id: result.group.id },
      data: { referralCode: newCode },
    });

    res.json({ referralCode: newCode });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Membership ----------

// POST /api/groups/join — join via referral code (instant)
router.post('/join', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const { referralCode } = req.body;

    if (!referralCode) {
      res.status(400).json({ error: 'referralCode is required' });
      return;
    }

    const group = await prisma.group.findUnique({
      where: { referralCode: referralCode.toUpperCase().trim() },
    });
    if (!group) {
      res.status(404).json({ error: 'Invalid referral code' });
      return;
    }

    const existing = await getGroupMembership(group.id, auth.userId);
    if (existing) {
      res.status(409).json({ error: 'You are already a member of this group' });
      return;
    }

    await prisma.groupMember.create({
      data: { groupId: group.id, userId: auth.userId, role: 'student' },
    });

    res.json(group);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups/:id/request-join — request to join (needs approval)
router.post('/:id/request-join', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const groupId = req.params.id as string;
    const { message } = req.body;

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const existingMember = await getGroupMembership(groupId, auth.userId);
    if (existingMember) {
      res.status(409).json({ error: 'You are already a member' });
      return;
    }

    const existingRequest = await prisma.groupJoinRequest.findUnique({
      where: { groupId_userId: { groupId, userId: auth.userId } },
    });
    if (existingRequest && existingRequest.status === 'pending') {
      res.status(409).json({ error: 'You already have a pending request' });
      return;
    }

    const joinRequest = await prisma.groupJoinRequest.upsert({
      where: { groupId_userId: { groupId, userId: auth.userId } },
      create: { groupId, userId: auth.userId, message: message || null },
      update: { status: 'pending', message: message || null },
    });

    // SSE notify group managers
    const managers = await prisma.groupMember.findMany({
      where: { groupId, role: { in: ['owner', 'teacher'] } },
      select: { userId: true },
    });
    sseManager.sendToUsers(
      managers.map((m) => m.userId),
      'join-request',
      { groupId, userId: auth.userId, username: auth.username },
    );

    res.status(201).json({ ...joinRequest, id: joinRequest.id.toString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/groups/:id/join-requests — list pending requests (owner/teacher)
router.get('/:id/join-requests', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner', 'teacher'],
      res,
    );
    if (!result) return;

    const requests = await prisma.groupJoinRequest.findMany({
      where: { groupId: result.group.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, fullName: true, username: true, avatarUrl: true } },
      },
    });

    res.json(requests.map((r: any) => ({ ...r, id: r.id.toString() })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups/:id/approve-join/:requestId — approve join request
router.post('/:id/approve-join/:requestId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner', 'teacher'],
      res,
    );
    if (!result) return;

    const joinRequest = await prisma.groupJoinRequest.findUnique({
      where: { id: BigInt(req.params.requestId as string) },
    });
    if (!joinRequest || joinRequest.groupId !== result.group.id) {
      res.status(404).json({ error: 'Join request not found' });
      return;
    }
    if (joinRequest.status !== 'pending') {
      res.status(400).json({ error: 'Request already processed' });
      return;
    }

    const role = req.body.role === 'teacher' ? 'teacher' : 'student';

    await prisma.$transaction([
      prisma.groupJoinRequest.update({
        where: { id: joinRequest.id },
        data: { status: 'approved' },
      }),
      prisma.groupMember.create({
        data: { groupId: result.group.id, userId: joinRequest.userId, role },
      }),
    ]);

    sseManager.sendToUser(joinRequest.userId, 'join-approved', {
      groupId: result.group.id,
      groupName: result.group.name,
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups/:id/reject-join/:requestId — reject join request
router.post('/:id/reject-join/:requestId', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner', 'teacher'],
      res,
    );
    if (!result) return;

    const joinRequest = await prisma.groupJoinRequest.findUnique({
      where: { id: BigInt(req.params.requestId as string) },
    });
    if (!joinRequest || joinRequest.groupId !== result.group.id) {
      res.status(404).json({ error: 'Join request not found' });
      return;
    }
    if (joinRequest.status !== 'pending') {
      res.status(400).json({ error: 'Request already processed' });
      return;
    }

    await prisma.groupJoinRequest.update({
      where: { id: joinRequest.id },
      data: { status: 'rejected' },
    });

    sseManager.sendToUser(joinRequest.userId, 'join-rejected', {
      groupId: result.group.id,
      groupName: result.group.name,
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups/:id/add-teacher — owner adds a teacher to the group
router.post('/:id/add-teacher', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner'],
      res,
    );
    if (!result) return;

    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const existingMember = await getGroupMembership(result.group.id, userId);
    if (existingMember) {
      await prisma.groupMember.update({
        where: { groupId_userId: { groupId: result.group.id, userId } },
        data: { role: 'teacher' },
      });
    } else {
      await prisma.groupMember.create({
        data: { groupId: result.group.id, userId, role: 'teacher' },
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups/:id/leave
router.post('/:id/leave', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const membership = await getGroupMembership(req.params.id as string, auth.userId);
    if (!membership) {
      res.status(404).json({ error: 'You are not a member of this group' });
      return;
    }
    if (membership.role === 'owner') {
      res.status(400).json({
        error: 'Owner cannot leave. Transfer ownership or delete the group.',
      });
      return;
    }

    await prisma.groupMember.delete({
      where: { groupId_userId: { groupId: req.params.id as string, userId: auth.userId } },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/groups/:id/remove-member — owner/teacher removes a member
router.post('/:id/remove-member', async (req: Request, res: Response) => {
  try {
    const auth = (req as AuthenticatedRequest).auth!;
    const result = await requireGroupRole(
      req.params.id as string,
      auth.userId,
      ['owner', 'teacher'],
      res,
    );
    if (!result) return;

    const { userId } = req.body;
    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    const targetMembership = await getGroupMembership(result.group.id, userId);
    if (!targetMembership) {
      res.status(404).json({ error: 'User is not a member' });
      return;
    }
    if (targetMembership.role === 'owner') {
      res.status(403).json({ error: 'Cannot remove the group owner' });
      return;
    }
    if (result.membership.role === 'teacher' && targetMembership.role === 'teacher') {
      res.status(403).json({ error: 'Only the owner can remove teachers' });
      return;
    }

    await prisma.groupMember.delete({
      where: { groupId_userId: { groupId: result.group.id, userId } },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
