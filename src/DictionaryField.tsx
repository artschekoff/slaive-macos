import { useEffect, useRef, useState } from 'react'
import { createTranscriptEditor, watchVimMode, type VimMode } from './transcript-editor'

// Поле словаря терминов в настройках — ТОТ ЖЕ редактор, что в панели и в
// главном окне (см. transcript-editor.ts): CodeMirror 6 + codemirror-vim,
// те же расширения, тот же ремап построчной навигации, те же стили
// .transcript-field. Третьего варианта поля в приложении нет.
//
// Отдельный компонент, а не кусок разметки внутри Settings.tsx, по причине
// механической: CodeMirror владеет своим DOM императивно, ему нужны ref и
// эффект монтирования, а Settings() до загрузки настроек делает ранний
// возврат («Loading…») — хуки редактора выше этого возврата жить не могут, а
// ниже их объявить нельзя.
//
// ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ: ни одного Vim.mapCommand. Оверлей вешает <CR> на
// вставку и <Esc> на закрытие панели модульно, при импорте Overlay.tsx, — но
// окно настроек это отдельный webview со своим JS-контекстом и Overlay.tsx не
// импортирует, так что те команды тут не зарегистрированы. Своих здесь не
// добавляем тоже (см. решение про Escape в брифе): Escape в этом поле —
// обычный вимовский выход из insert в normal и дальше окна не идёт. Закрывать
// окно настроек по Escape было бы прямым способом потерять несохранённые
// правки: у этого окна есть кнопка Save, и она единственный способ записать.
type Props = {
  /** Начальное содержимое — берётся ОДИН раз, при монтировании. Поле
   *  неуправляемое: источник истины в документе CodeMirror, а `onChange` ниже
   *  зеркалит его наружу. Возвращать значение обратно пропсом нельзя — на
   *  каждом нажатии клавиши это перетирало бы документ и сбрасывало курсор.
   *
   *  Оговорка, из-за которой это безопасно: единственный, кто меняет
   *  `dictionary` в состоянии настроек, — сам этот компонент. Настройки
   *  читаются с бэкенда один раз, до первого рендера поля (пока их нет,
   *  Settings рисует «Loading…»). */
  initialValue: string
  /** Вызывается на каждое изменение документа. Да, на каждый символ — в
   *  отличие от оверлея и главного окна, которые читают документ в момент
   *  действия. Причин две, и обе структурные, а не вкусовые:
   *
   *  1. Кнопка Save живёт в подвале окна, СНАРУЖИ раздела. Переключение на
   *     соседний раздел размонтирует Recognition вместе с редактором, и
   *     документ, из которого можно было бы прочитать текст «в момент
   *     Save», к этому моменту уже уничтожен. Без зеркалирования правка
   *     словаря молча пропадала бы у всякого, кто заглянул в другой раздел
   *     перед сохранением.
   *  2. Счётчик бюджета подсказки (см. prompt-budget.ts) обязан считать по
   *     тому, что в поле прямо сейчас, иначе он бесполезен. */
  onChange: (value: string) => void
}

export function DictionaryField({ initialValue, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [vimMode, setVimMode] = useState<VimMode>('normal')

  // `onChange` держим в ref: эффект создания редактора должен выполниться
  // РОВНО один раз (CodeMirror пересоздавать на каждый рендер нельзя — это
  // потеря курсора, режима и истории undo), а `onChange` из Settings.tsx —
  // новая функция на каждом рендере и в список зависимостей не годится.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  // initialValue тоже читается один раз, здесь — намеренно не в зависимостях
  // эффекта ниже (см. докстринг пропа).
  const initialRef = useRef(initialValue)

  useEffect(() => {
    const parent = containerRef.current
    if (!parent) return
    const view = createTranscriptEditor(parent, {
      doc: initialRef.current,
      onDocText: (text) => onChangeRef.current(text),
      // Плейсхолдер виден только у пустого словаря — а пустой словарь это
      // рабочее состояние («не подсказывать whisper ничего»), не ошибка.
      // Показываем им же и предпочтительную форму записи: по термину в строке.
      placeholderText: 'React\nKubernetes\nDocker Compose',
    })
    const unwatch = watchVimMode(view, setVimMode)
    // Ссылку на view наружу не держим — в отличие от оверлея и главного окна
    // тут её негде и незачем читать: текст уходит наверх сам, через onDocText.
    return () => {
      unwatch()
      view.destroy()
    }
  }, [])

  return (
    <div className="field">
      {/* Подпись и бейдж режима в одной строке: бейдж относится к полю под
          ними и должен быть виден, пока в поле работают. Без него модальный
          Escape — гадание: в INSERT он возвращает в NORMAL, в NORMAL уже
          ничего не делает, а на глаз состояния не различить. Ровно тот же
          .vim-mode, что в панели и главном окне, — не копия. */}
      <span className="dictionary-head">
        Dictionary
        <span className={`vim-mode vim-mode-${vimMode}`}>{vimMode.toUpperCase()}</span>
      </span>
      <div className="transcript-field dictionary-editor" ref={containerRef} />
    </div>
  )
}
