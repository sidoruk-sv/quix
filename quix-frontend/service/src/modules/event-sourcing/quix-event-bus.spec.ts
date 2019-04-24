import {TestingModule} from '@nestjs/testing';
import 'reflect-metadata';
import {INote, NoteActions, createNote} from 'shared/entities/note';
import {NoteActionT} from 'shared/entities/note/actions';
import {NotebookActions} from 'shared/entities/notebook';
import {FileActions, FileType} from 'shared/entities/file';
import {QuixEventBus} from './quix-event-bus';
import {QuixEventBusDriver} from './quix-event-bus.driver';
import {range, reject} from 'lodash';

/* tslint:disable:no-shadowed-variable */
jest.setTimeout(30000);

const defaultUser = 'someUser@wix.com';

describe('event sourcing', () => {
  let driver: QuixEventBusDriver;

  let eventBus: QuixEventBus;
  let module: TestingModule;
  // let notebookRepo: Repository<DbNotebook>;
  // let noteRepo: Repository<DbNote>;

  beforeAll(async () => {
    driver = await QuixEventBusDriver.create(defaultUser);
    ({eventBus, module} = await driver);
  });

  beforeEach(() => driver.clearDb());
  afterAll(() => driver.clearDb());

  afterAll(() => module.close());

  describe('notebooks::', () => {
    let id: string;
    let createAction: NotebookActions;

    beforeEach(() => {
      [id, createAction] = driver.createNotebookAction();
    });

    it('create notebook', async () => {
      await driver.emitAsUser(eventBus, [createAction]);
      const notebook = await driver.getNotebook(id).and.expectToBeDefined();

      expect(notebook.id).toBe(createAction.id);
    });

    it('set owner correctly', async () => {
      await driver.emitAsUser(eventBus, [createAction]);
      const notebook = await driver.getNotebook(id).and.expectToBeDefined();

      expect(notebook.owner).toBe(defaultUser);
    });

    it('update name', async () => {
      await driver.emitAsUser(eventBus, [
        createAction,
        NotebookActions.updateName(id, 'newName'),
      ]);

      const notebook = await driver.getNotebook(id).and.expectToBeDefined();

      expect(notebook.name).toBe('newName');
    });

    // it('update isLiked', async () => {
    //   await driver.emitAsUser(eventBus, [
    //     createAction,
    //     NotebookActions.toggleIsLiked(id, true),
    //   ]);
    //   const notebook = await driver.getNotebook(id).and.expectToBeDefined();

    //   expect(notebook.isLiked).toBe(true);
    // });

    it('delete', async () => {
      await eventBus.emit(createAction);
      const notebook = await driver.getNotebook(id).and.expectToBeDefined();

      expect(notebook.id).toBe(createAction.id);

      await driver.emitAsUser(eventBus, [NotebookActions.deleteNotebook(id)]);

      await driver.getNotebook(id).and.expectToBeUndefined();
    });
  });

  describe('notes::', () => {
    let notebookId: string;
    let createNotebookAction: NotebookActions;
    let addNoteAction: NoteActionT<'note.create'>;
    let note: INote;

    beforeEach(() => {
      [notebookId, createNotebookAction] = driver.createNotebookAction();
      note = createNote(notebookId);
      addNoteAction = NoteActions.addNote(note.id, note);
    });

    it('create note', async () => {
      await driver.emitAsUser(eventBus, [createNotebookAction]);
      await driver.emitAsUser(eventBus, [addNoteAction]);

      const notebook = await driver.getNotebookWithNotes(notebookId);

      expect(notebook.notes).toHaveLength(1);
    });

    it('create note with bulk actions', async () => {
      await driver.emitAsUser(eventBus, [createNotebookAction, addNoteAction]);

      const notebook = await driver.getNotebookWithNotes(notebookId);

      expect(notebook.notes).toHaveLength(1);
      const {id, name, notebookId: parent, type} = note;
      expect(notebook.notes[0]).toMatchObject(
        expect.objectContaining({
          id,
          name,
          notebookId: parent,
          owner: defaultUser,
          type,
        }),
      );
    });

    it('update name', async () => {
      await driver.emitAsUser(eventBus, [createNotebookAction, addNoteAction]);

      await driver.emitAsUser(eventBus, [
        NoteActions.updateName(note.id, 'changedName'),
      ]);
      const notebook = await driver.getNotebookWithNotes(notebookId);

      expect(notebook.notes[0].name).toBe('changedName');
    });

    it('delete note', async () => {
      await driver.emitAsUser(eventBus, [createNotebookAction, addNoteAction]);

      await driver.emitAsUser(eventBus, [NoteActions.deleteNote(note.id)]);
      const notebook = await driver.getNotebookWithNotes(notebookId);

      expect(notebook.notes).toHaveLength(0);
    });

    it('update content', async () => {
      await driver.emitAsUser(eventBus, [createNotebookAction, addNoteAction]);

      await driver.emitAsUser(eventBus, [
        NoteActions.updateContent(note.id, 'select foo from bar'),
      ]);
      const notebook = await driver.getNotebookWithNotes(notebookId);

      expect(notebook.notes[0].content).toBe('select foo from bar');
    });

    it('move notebook', async () => {
      await driver.emitAsUser(eventBus, [createNotebookAction, addNoteAction]);
      const [
        secondNotebookId,
        createNotebookAction2,
      ] = driver.createNotebookAction();

      await driver.emitAsUser(eventBus, [createNotebookAction2]);

      await driver.emitAsUser(eventBus, [
        NoteActions.move(note.id, secondNotebookId),
      ]);

      const notebook = await driver.getNotebookWithNotes(notebookId);
      expect(notebook.notes).toHaveLength(0);

      const secondNotebook = await driver.getNotebookWithNotes(
        secondNotebookId,
      );
      expect(secondNotebook.notes).toHaveLength(1);
    });

    describe('note rank/order', () => {
      let notes: INote[];
      let createNoteActions: NoteActionT<'note.create'>[];
      const howManyNotes = 6;

      beforeEach(async () => {
        notes = range(howManyNotes).map(() => createNote(notebookId));
        createNoteActions = notes.map(n => NoteActions.addNote(n.id, n));

        await driver.emitAsUser(eventBus, [createNotebookAction]);
        await driver.emitAsUser(eventBus, createNoteActions);
      });

      it('should create new notes with correct order', async () => {
        const notebook = await driver.getNotebookWithNotes(notebookId);
        const doesRankMatchInsertOrder = notes.every(
          (note, index) =>
            notebook.notes.find(n => n.id === note.id)!.rank === index,
        );

        expect(doesRankMatchInsertOrder).toBeTruthy();
      });

      const deleteCases = [
        [0, 'start'],
        [howManyNotes - 1, 'end'],
        [3, 'middle'],
      ] as const;

      deleteCases.forEach(([noteIndexToDelete, testName]) => {
        it(`on delete should set order of remaining notes correctly, when removing from ${testName}`, async () => {
          const noteIdToDelete = notes[noteIndexToDelete].id;
          const deleteAction = NoteActions.deleteNote(noteIdToDelete);
          await driver.emitAsUser(eventBus, [deleteAction]);

          const filteredNotes = reject(notes, {id: noteIdToDelete});

          const notebook = await driver.getNotebookWithNotes(notebookId);
          const doesRankMatchInsertOrder = filteredNotes.every(
            (note, index) =>
              notebook.notes.find(n => n.id === note.id)!.rank === index,
          );

          expect(doesRankMatchInsertOrder).toBeTruthy();
        });
      });

      const reorderCases = [
        [4, 2, '"from" greater than "to"'],
        [1, 5, '"to" greater than "from"'],
      ] as const;

      reorderCases.forEach(([from, to, testName]) => {
        it(`reorder notes correctly, when ${testName}`, async () => {
          const noteIdMove = notes[from].id;
          const reorderAction = NoteActions.reorderNote(noteIdMove, to);
          await driver.emitAsUser(eventBus, [reorderAction]);

          const reorderdNotes = reorderPos(notes, from, to);
          const notebook = await driver.getNotebookWithNotes(notebookId);

          const doesRankMatchInsertOrder = reorderdNotes.every(
            (note, index) =>
              notebook.notes.find(n => n.id === note.id)!.rank === index,
          );

          expect(doesRankMatchInsertOrder).toBeTruthy();
        });
      });
    });
  });

  describe('folder tree::', () => {
    let id: string;
    let createFolderAction: any;
    let notebookId: string;
    let createNotebookAction: any;

    beforeEach(() => {
      [id, createFolderAction] = driver.createFolderAction('newFolder', []);
      [notebookId, createNotebookAction] = driver.createNotebookAction([
        {id, name: 'doesnt matter'},
      ]);
    });

    it('a single folder', async () => {
      await driver.emitAsUser(eventBus, [createFolderAction]);

      const list = await driver.getFolderDecendents(defaultUser);
      expect(list[0].folder!.name).toBe('newFolder');
    });

    it('rename folder', async () => {
      await driver.emitAsUser(eventBus, [createFolderAction]);
      await driver.emitAsUser(eventBus, [
        FileActions.updateName(id, 'a changedName'),
      ]);

      const list = await driver.getFolderDecendents(defaultUser);
      expect(list[0].folder!.name).toBe('a changedName');
    });

    it('a notebook inside a single folder', async () => {
      await driver.emitAsUser(eventBus, [
        createFolderAction,
        createNotebookAction,
      ]);

      const list = await driver.getFolderDecendents(defaultUser);
      const notebookTreeItem = list.find(
        item => item.id === notebookId && item.parentId === id,
      );
      expect(notebookTreeItem).toBeDefined();
    });

    it('multiple notebooks inside a single folder', async () => {
      const [notebookId2, createNotebookAction2] = driver.createNotebookAction([
        {id, name: 'doesnt matter'},
      ]);
      await driver.emitAsUser(eventBus, [
        createFolderAction,
        createNotebookAction,
        createNotebookAction2,
      ]);

      const list = await driver.getFolderDecendents(defaultUser);
      const notebookItems = list.filter(
        item => item.type === FileType.notebook,
      );
      expect(notebookItems).toHaveLength(2);
    });
  });
});

function reorderPos<T>(items: T[], from: number, to: number) {
  const clone = items.slice();
  const [item] = clone.splice(from, 1);
  clone.splice(to, 0, item);

  return clone;
}
